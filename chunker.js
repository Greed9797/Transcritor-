const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHUNK_SIZE_MB = parseInt(process.env.CHUNK_SIZE_MB || '20');
const CHUNK_SIZE_BYTES = CHUNK_SIZE_MB * 1024 * 1024;

function getAudioDuration(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
  ).toString().trim();
  return parseFloat(out);
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size;
}

async function chunkAudio(filePath, outputDir) {
  const fileSize = getFileSize(filePath);

  if (fileSize <= CHUNK_SIZE_BYTES) {
    const dest = path.join(outputDir, 'chunk_001' + path.extname(filePath));
    fs.copyFileSync(filePath, dest);
    return [dest];
  }

  const duration = getAudioDuration(filePath);
  const numChunks = Math.ceil(fileSize / CHUNK_SIZE_BYTES);
  const chunkDuration = Math.floor(duration / numChunks);

  const chunks = [];
  const promises = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkDuration;
    const chunkNum = String(i + 1).padStart(3, '0');
    const outFile = path.join(outputDir, `chunk_${chunkNum}.mp3`);
    chunks.push(outFile);

    const isLast = i === numChunks - 1;
    const durationArg = isLast ? '' : `-t ${chunkDuration}`;

    promises.push(new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -i "${filePath}" -ss ${start} ${durationArg} -acodec libmp3lame -q:a 4 "${outFile}"`,
        (err) => err ? reject(err) : resolve()
      );
    }));
  }

  await Promise.all(promises);
  return chunks.sort();
}

function mergeTranscriptions(texts) {
  return texts.join('\n\n');
}

module.exports = { chunkAudio, mergeTranscriptions, getAudioDuration };
