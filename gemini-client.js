const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');

const MODEL = 'gemini-2.5-flash-lite';

// Video extensions that benefit from audio extraction before upload
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv']);

const MIME_MAP = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.webm': 'audio/webm', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.mp4': 'audio/mpeg', // after extraction this will be mp3
};

function getMimeType(fp) {
  return MIME_MAP[path.extname(fp).toLowerCase()] || 'audio/mpeg';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|exceeded/i.test(err?.message || '');
}

function getGeminiKeys() {
  const keys = [];
  let i = 1;
  while (process.env[`GEMINI_API_KEY_${i}`]) {
    keys.push(process.env[`GEMINI_API_KEY_${i}`]);
    i++;
  }
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY);
  }
  return keys;
}

// Extract audio from video as compact opus (64kbps) — 30x smaller than MP4
function extractAudio(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return filePath; // already audio

  const tmpOut = path.join(os.tmpdir(), `gemini_audio_${Date.now()}.mp3`);
  console.log(`[gemini] extracting audio from ${path.basename(filePath)} → ${path.basename(tmpOut)}`);
  execSync(
    `ffmpeg -y -i "${filePath}" -vn -acodec libmp3lame -q:a 4 -ar 16000 -ac 1 "${tmpOut}"`,
    { stdio: 'pipe' }
  );
  console.log(`[gemini] extracted: ${(fs.statSync(tmpOut).size / 1024 / 1024).toFixed(1)}MB`);
  return tmpOut;
}

async function uploadAndWait(fileManager, filePath, displayName) {
  const mimeType = getMimeType(filePath);
  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
  console.log(`[gemini] uploading ${displayName} (${sizeMB}MB, ${mimeType})`);
  const upload = await fileManager.uploadFile(filePath, { mimeType, displayName });
  let file = upload.file;
  let polls = 0;
  while (file.state === 'PROCESSING') {
    await sleep(1000); // poll every 1s instead of 3s
    file = await fileManager.getFile(file.name);
    polls++;
    if (polls % 5 === 0) console.log(`[gemini] still processing... (${polls}s)`);
  }
  if (file.state === 'FAILED') throw new Error(`Gemini file processing failed: ${file.name}`);
  return file;
}

async function transcribeWithKey(apiKey, filePath, language) {
  const delay = parseInt(process.env.DELAY_BETWEEN_REQUESTS_MS || '1000');

  // Extract audio track if input is video — much faster upload + processing
  let audioPath = filePath;
  let tmpCreated = false;
  try {
    audioPath = extractAudio(filePath);
    tmpCreated = audioPath !== filePath;

    const fileManager = new GoogleAIFileManager(apiKey);
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL });
    const displayName = path.basename(filePath); // keep original name for context

    const file = await uploadAndWait(fileManager, audioPath, displayName);

    const langInstruction = language && language !== 'auto'
      ? `O áudio está em ${language === 'pt' ? 'português' : language}. `
      : '';

    const result = await model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      { text: `${langInstruction}Transcreva este áudio integralmente, palavra por palavra, sem resumir, sem comentários. Retorne apenas o texto transcrito.` },
    ]);

    await fileManager.deleteFile(file.name).catch(() => {});
    await sleep(delay);
    return result.response.text();
  } finally {
    if (tmpCreated && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
}

async function transcribeSingleFile(filePath, language = 'pt', { onKeyExhausted } = {}) {
  const keys = getGeminiKeys();
  if (keys.length === 0) throw new Error('No GEMINI_API_KEY configured');

  let lastErr;
  for (let ki = 0; ki < keys.length; ki++) {
    const masked = keys[ki].slice(0, 4) + '****' + keys[ki].slice(-4);
    try {
      console.log(`[gemini] key ${ki + 1}/${keys.length} (${masked})`);
      return await transcribeWithKey(keys[ki], filePath, language);
    } catch (err) {
      lastErr = err;
      if (isQuotaError(err)) {
        console.warn(`[gemini] key ${ki + 1} quota hit — ${ki + 1 < keys.length ? 'trying next' : 'all exhausted'}`);
        if (onKeyExhausted) onKeyExhausted(ki, keys.length);
      } else {
        console.error(`[gemini] key ${ki + 1} error: ${err.message}. retry in 5s`);
        await sleep(5000);
        try { return await transcribeWithKey(keys[ki], filePath, language); }
        catch (retryErr) { lastErr = retryErr; }
      }
    }
  }
  throw lastErr;
}

async function transcribeFile(filePaths, onChunkDone, language = 'pt', opts = {}) {
  const texts = [];
  for (let i = 0; i < filePaths.length; i++) {
    const text = await transcribeSingleFile(filePaths[i], language, opts);
    texts.push(text);
    if (onChunkDone) onChunkDone(i + 1, filePaths.length);
  }
  return texts;
}

module.exports = { transcribeFile, transcribeSingleFile, getGeminiKeys };
