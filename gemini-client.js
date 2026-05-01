const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');

const DELAY = parseInt(process.env.DELAY_BETWEEN_REQUESTS_MS || '2000');
const MAX_RETRIES = 3;
const MODEL = 'gemini-1.5-flash';

const MIME_MAP = {
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
};

function getMimeType(filePath) {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/mpeg';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function uploadAndWait(fileManager, filePath, originalName) {
  const mimeType = getMimeType(filePath);
  console.log(`[gemini] uploading ${originalName} (${mimeType})...`);

  const upload = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: originalName,
  });

  let file = upload.file;
  while (file.state === 'PROCESSING') {
    await sleep(3000);
    file = await fileManager.getFile(file.name);
  }

  if (file.state === 'FAILED') {
    throw new Error(`Gemini file processing failed: ${file.name}`);
  }

  return file;
}

async function transcribeSingleFile(filePath, originalName, language = 'pt') {
  const apiKey = process.env.GEMINI_API_KEY;
  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const file = await uploadAndWait(fileManager, filePath, originalName);

      const langInstruction = language !== 'auto'
        ? `O áudio está em ${language === 'pt' ? 'português' : language}. `
        : '';

      const result = await model.generateContent([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri,
          },
        },
        {
          text: `${langInstruction}Transcreva este áudio integralmente, palavra por palavra, sem resumir, sem comentários. Retorne apenas o texto transcrito.`,
        },
      ]);

      // cleanup uploaded file from Gemini servers
      await fileManager.deleteFile(file.name).catch(() => {});
      await sleep(DELAY);

      return result.response.text();
    } catch (err) {
      lastErr = err;
      const isQuota = err?.status === 429;
      const backoff = isQuota ? 60000 : attempt * 5000;
      console.error(`[gemini] attempt ${attempt} failed: ${err.message}. retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw lastErr;
}

// Compatible interface with groq-client: receives array of file paths, returns array of strings
// For Gemini, chunks array = [originalFile] (no chunking needed)
async function transcribeFile(filePaths, onChunkDone, language = 'pt') {
  const texts = [];
  for (let i = 0; i < filePaths.length; i++) {
    const text = await transcribeSingleFile(filePaths[i], path.basename(filePaths[i]), language);
    texts.push(text);
    if (onChunkDone) onChunkDone(i + 1, filePaths.length);
  }
  return texts;
}

module.exports = { transcribeFile, transcribeSingleFile };
