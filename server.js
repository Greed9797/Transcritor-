require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { createJob, getJob, getAllJobs, updateJob, deleteJob, resetStuckJobs } = require('./queue');
const { chunkAudio, mergeTranscriptions } = require('./chunker');
const { transcribeFile } = require('./groq-client');

const app = express();
const PORT = process.env.PORT || 3030;

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let processing = false;

// SSE clients
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/jobs', (req, res) => {
  res.json(getAllJobs());
});

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
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'no files' });
  }

  const language = req.body.language || 'pt';
  const jobs = req.files.map(f => createJob(f.filename, f.originalname, f.path));
  res.json({ jobs, queued: jobs.length });
  processQueue(language);
});

async function processQueue(language = 'pt') {
  if (processing) return;
  processing = true;

  try {
    const allJobs = getAllJobs().filter(j => j.status === 'pending');

    for (const job of allJobs) {
      broadcast({ type: 'job_start', id: job.id, name: job.original_name });
      updateJob(job.id, { status: 'processing' });

      const chunkDir = path.join(__dirname, 'uploads', `chunks_${job.id}`);
      fs.mkdirSync(chunkDir, { recursive: true });

      try {
        const chunks = await chunkAudio(job.filepath, chunkDir);
        updateJob(job.id, { total_chunks: chunks.length });
        broadcast({ type: 'job_update', id: job.id, total_chunks: chunks.length });

        const texts = await transcribeFile(chunks, (done, total) => {
          const progress = Math.round((done / total) * 100);
          updateJob(job.id, { done_chunks: done, progress });
          broadcast({ type: 'job_progress', id: job.id, progress, done, total });
        }, language);

        const fullText = mergeTranscriptions(texts);
        const outPath = path.join(__dirname, 'transcriptions', `${job.id}_${job.original_name.replace(/\.[^.]+$/, '')}.txt`);
        fs.writeFileSync(outPath, fullText, 'utf8');

        updateJob(job.id, { status: 'done', progress: 100, output_path: outPath });
        broadcast({ type: 'job_done', id: job.id });
      } catch (err) {
        updateJob(job.id, { status: 'error', error: err.message });
        broadcast({ type: 'job_error', id: job.id, error: err.message });
      } finally {
        // cleanup chunks
        fs.rmSync(chunkDir, { recursive: true, force: true });
      }
    }
  } finally {
    processing = false;
  }
}

resetStuckJobs();

app.listen(PORT, () => {
  console.log(`\n🎙  Audio Transcriber running at http://localhost:${PORT}\n`);
});
