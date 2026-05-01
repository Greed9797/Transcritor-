const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const MODEL = 'gemini-2.5-flash-lite';

const MIME_MAP = {
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.webm': 'audio/webm', '.aac': 'audio/aac', '.opus': 'audio/opus',
};

function getMimeType(fp) {
  return MIME_MAP[path.extname(fp).toLowerCase()] || 'audio/mpeg';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|exceeded/i.test(err?.message || '');
}

// Read all Gemini keys from env: GEMINI_API_KEY_1, _2, … or fallback to GEMINI_API_KEY
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

async function uploadAndWait(fileManager, filePath, displayName) {
  const mimeType = getMimeType(filePath);
  console.log(`[gemini] uploading ${displayName} (${mimeType})`);
  const upload = await fileManager.uploadFile(filePath, { mimeType, displayName });
  let file = upload.file;
  while (file.state === 'PROCESSING') {
    await sleep(3000);
    file = await fileManager.getFile(file.name);
  }
  if (file.state === 'FAILED') throw new Error(`Gemini file processing failed: ${file.name}`);
  return file;
}

async function transcribeWithKey(apiKey, filePath, language, onBroadcast) {
  const delay = parseInt(process.env.DELAY_BETWEEN_REQUESTS_MS || '2000');
  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL });
  const displayName = path.basename(filePath);

  const file = await uploadAndWait(fileManager, filePath, displayName);

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
}

// Rotates through all configured Gemini keys on quota errors.
// onKeyExhausted(keyIndex, total) — called when a key hits quota.
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
        console.warn(`[gemini] key ${ki + 1} quota hit — ${ki + 1 < keys.length ? 'trying next key' : 'all keys exhausted'}`);
        if (onKeyExhausted) onKeyExhausted(ki, keys.length);
        // continue to next key
      } else {
        // non-quota error: retry same key up to 2x with backoff
        const backoff = (ki + 1) * 5000;
        console.error(`[gemini] key ${ki + 1} error: ${err.message}. retry in ${backoff}ms`);
        await sleep(backoff);
        try {
          return await transcribeWithKey(keys[ki], filePath, language);
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
    }
  }

  throw lastErr;
}

// Interface-compatible with groq-client
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
