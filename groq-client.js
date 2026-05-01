const Groq = require('groq-sdk');
const fs = require('fs');

const DELAY = parseInt(process.env.DELAY_BETWEEN_REQUESTS_MS || '1000');
const MAX_RETRIES = 3;

let groq;

function getClient() {
  if (!groq) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groq;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function transcribeChunk(chunkPath, language = 'pt') {
  const client = getClient();
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.audio.transcriptions.create({
        file: fs.createReadStream(chunkPath),
        model: 'whisper-large-v3',
        language,
        response_format: 'text',
      });
      await sleep(DELAY);
      return typeof response === 'string' ? response : response.text;
    } catch (err) {
      lastErr = err;
      const isRateLimit = err?.status === 429;
      const backoff = isRateLimit ? 60000 : attempt * 3000;
      console.error(`[groq] chunk ${chunkPath} attempt ${attempt} failed: ${err.message}. retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw lastErr;
}

async function transcribeFile(chunkPaths, onChunkDone, language = 'pt') {
  const texts = [];
  for (let i = 0; i < chunkPaths.length; i++) {
    const text = await transcribeChunk(chunkPaths[i], language);
    texts.push(text);
    if (onChunkDone) onChunkDone(i + 1, chunkPaths.length);
  }
  return texts;
}

module.exports = { transcribeFile, transcribeChunk };
