require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { createJob, getJob, getAllJobs, updateJob, deleteJob, resetStuckJobs } = require('./queue');
const { chunkAudio, mergeTranscriptions } = require('./chunker');

const app = express();
const PORT = process.env.PORT || 3030;
const ENV_PATH = path.join(__dirname, '.env');

// ── Provider helpers ──────────────────────────────────────────────────────────

function getProvider() {
  const forced = (process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase();
  if (forced === 'groq') return 'groq';
  if (forced === 'gemini') return 'gemini';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'groq';
}

function getFallbackProvider() {
  const fb = (process.env.FALLBACK_PROVIDER || '').toLowerCase();
  if (fb === 'groq' || fb === 'gemini' || fb === 'none') return fb;
  return 'none';
}

function getClientForProvider(provider) {
  return provider === 'gemini'
    ? require('./gemini-client')
    : require('./groq-client');
}

function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|exceeded/i.test(err?.message || '');
}

// ── .env read/write ───────────────────────────────────────────────────────────

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const result = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

function writeEnvFile(vars) {
  const existing = readEnvFile();
  const merged = { ...existing, ...vars };
  const content = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function maskKey(key) {
  if (!key || key.length < 8) return key ? '****' : '';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

// ── Express setup ─────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 2048 * 1024 * 1024 },
});

let processing = false;
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ── SSE ───────────────────────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Config API ────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const env = readEnvFile();
  res.json({
    provider: getProvider(),
    fallbackProvider: getFallbackProvider(),
    geminiKeySet: !!env.GEMINI_API_KEY,
    groqKeySet: !!env.GROQ_API_KEY,
    geminiKeyMasked: maskKey(env.GEMINI_API_KEY),
    groqKeyMasked: maskKey(env.GROQ_API_KEY),
    delayMs: parseInt(env.DELAY_BETWEEN_REQUESTS_MS || '2000'),
  });
});

app.post('/api/config', (req, res) => {
  const { provider, fallbackProvider, geminiKey, groqKey, delayMs } = req.body;
  const updates = {};

  if (provider) updates.TRANSCRIPTION_PROVIDER = provider;
  if (fallbackProvider !== undefined) updates.FALLBACK_PROVIDER = fallbackProvider;
  if (geminiKey && geminiKey.trim()) updates.GEMINI_API_KEY = geminiKey.trim();
  if (groqKey && groqKey.trim()) updates.GROQ_API_KEY = groqKey.trim();
  if (delayMs) updates.DELAY_BETWEEN_REQUESTS_MS = String(delayMs);

  writeEnvFile(updates);

  // Reload into process.env
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;

  // Bust require cache so next processQueue picks up new keys
  delete require.cache[require.resolve('./gemini-client')];
  delete require.cache[require.resolve('./groq-client')];

  res.json({ ok: true, provider: getProvider(), fallbackProvider: getFallbackProvider() });
});

// ── Jobs API ──────────────────────────────────────────────────────────────────

app.get('/api/jobs', (req, res) => res.json(getAllJobs()));

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = getJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.filepath && fs.existsSync(job.filepath)) fs.unlinkSync(job.filepath);
  deleteJob(job.id);
  res.json({ ok: true });
});

app.get('/api/download/:id', (req, res) => {
  const job = getJob(parseInt(req.params.id));
  if (!job || !job.output_path) return res.status(404).json({ error: 'not ready' });
  res.download(job.output_path, job.original_name.replace(/\.[^.]+$/, '.txt'));
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'no files' });
  const language = req.body.language || 'pt';
  const jobs = req.files.map(f => createJob(f.filename, f.originalname, f.path));
  res.json({ jobs, queued: jobs.length });
  processQueue(language);
});

// ── Queue processor ───────────────────────────────────────────────────────────

async function transcribeWithFallback(filesToTranscribe, provider, onChunkDone, language) {
  try {
    const { transcribeFile } = getClientForProvider(provider);
    return await transcribeFile(filesToTranscribe, onChunkDone, language);
  } catch (err) {
    const fallback = getFallbackProvider();
    if (isQuotaError(err) && fallback && fallback !== 'none' && fallback !== provider) {
      console.warn(`[server] ${provider} quota hit — switching to fallback: ${fallback}`);
      broadcast({ type: 'fallback_activated', from: provider, to: fallback });
      const { transcribeFile } = getClientForProvider(fallback);
      return await transcribeFile(filesToTranscribe, onChunkDone, language);
    }
    throw err;
  }
}

async function processQueue(language = 'pt') {
  if (processing) return;
  processing = true;

  try {
    const pending = getAllJobs().filter(j => j.status === 'pending');

    for (const job of pending) {
      const provider = getProvider();
      broadcast({ type: 'job_start', id: job.id, name: job.original_name });
      updateJob(job.id, { status: 'processing' });

      let chunkDir = null;
      try {
        let filesToTranscribe;

        if (provider === 'gemini') {
          filesToTranscribe = [job.filepath];
          updateJob(job.id, { total_chunks: 1 });
          broadcast({ type: 'job_update', id: job.id, total_chunks: 1 });
        } else {
          chunkDir = path.join(__dirname, 'uploads', `chunks_${job.id}`);
          fs.mkdirSync(chunkDir, { recursive: true });
          filesToTranscribe = await chunkAudio(job.filepath, chunkDir);
          updateJob(job.id, { total_chunks: filesToTranscribe.length });
          broadcast({ type: 'job_update', id: job.id, total_chunks: filesToTranscribe.length });
        }

        const texts = await transcribeWithFallback(
          filesToTranscribe,
          provider,
          (done, total) => {
            const progress = Math.round((done / total) * 100);
            updateJob(job.id, { done_chunks: done, progress });
            broadcast({ type: 'job_progress', id: job.id, progress, done, total });
          },
          language
        );

        const fullText = mergeTranscriptions(texts);
        const safeName = job.original_name.replace(/\.[^.]+$/, '').replace(/[^\w\sáéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ-]/g, '_');
        const outPath = path.join(__dirname, 'transcriptions', `${job.id}_${safeName}.txt`);
        fs.writeFileSync(outPath, fullText, 'utf8');

        updateJob(job.id, { status: 'done', progress: 100, output_path: outPath });
        broadcast({ type: 'job_done', id: job.id });
      } catch (err) {
        updateJob(job.id, { status: 'error', error: err.message });
        broadcast({ type: 'job_error', id: job.id, error: err.message });
      } finally {
        if (chunkDir) fs.rmSync(chunkDir, { recursive: true, force: true });
      }
    }
  } finally {
    processing = false;
  }
}

resetStuckJobs();

app.listen(PORT, () => {
  const provider = getProvider();
  const fallback = getFallbackProvider();
  console.log(`\n🎙  Audio Transcriber — http://localhost:${PORT}`);
  console.log(`   Provider : ${provider.toUpperCase()}`);
  if (fallback !== 'none') console.log(`   Fallback : ${fallback.toUpperCase()}`);
  console.log();
});
