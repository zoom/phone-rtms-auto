const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Runtime output lives in rtms/data, which is gitignored.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// RTMS audio is 16 kHz, 16-bit little-endian PCM, one stream per channel_id.
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const INTERLEAVE_CHUNK_BYTES = 64 * 1024;

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildWavHeader(dataSize, channels) {
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return header;
}

// Raw PCM -> WAV via ffmpeg, falling back to writing the WAV header ourselves.
async function convertRawToWav(rawFile, wavFile, channels) {
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(channels),
      '-i', rawFile,
      wavFile
    ]);
  } catch (error) {
    console.warn(`ffmpeg failed (${error.message}); writing WAV directly`);
    const pcm = fs.readFileSync(rawFile);
    fs.writeFileSync(wavFile, Buffer.concat([buildWavHeader(pcm.length, channels), pcm]));
  }
}

// Interleaves N mono 16-bit PCM files sample-by-sample (L R L R ... for two channels),
// zero-padding shorter channels. Streams in chunks so long calls don't load into memory.
function interleaveRawFiles(rawFiles, outFile) {
  const fds = rawFiles.map((file) => fs.openSync(file, 'r'));
  const out = fs.openSync(outFile, 'w');
  const chunks = fds.map(() => Buffer.alloc(INTERLEAVE_CHUNK_BYTES));
  const frameBytes = rawFiles.length * BYTES_PER_SAMPLE;

  try {
    for (;;) {
      const lengths = fds.map((fd, i) => {
        const read = fs.readSync(fd, chunks[i], 0, INTERLEAVE_CHUNK_BYTES, null);
        return read - (read % BYTES_PER_SAMPLE);
      });
      const samples = Math.max(...lengths) / BYTES_PER_SAMPLE;
      if (samples === 0) break;

      const result = Buffer.alloc(samples * frameBytes); // zero-filled = silence
      for (let c = 0; c < fds.length; c++) {
        for (let s = 0; s * BYTES_PER_SAMPLE < lengths[c]; s++) {
          chunks[c].copy(result, s * frameBytes + c * BYTES_PER_SAMPLE, s * BYTES_PER_SAMPLE, (s + 1) * BYTES_PER_SAMPLE);
        }
      }
      fs.writeSync(out, result);
    }
  } finally {
    [...fds, out].forEach((fd) => fs.closeSync(fd));
  }
}

// One raw file -> mono WAV. Several -> a single WAV with one interleaved channel per file.
async function saveWav(rawFiles, wavFile) {
  if (rawFiles.length === 1) return convertRawToWav(rawFiles[0], wavFile, 1);

  const interleavedFile = `${wavFile}.interleaved.raw`;
  interleaveRawFiles(rawFiles, interleavedFile);
  try {
    await convertRawToWav(interleavedFile, wavFile, rawFiles.length);
  } finally {
    fs.rmSync(interleavedFile, { force: true });
  }
}

// Finalize any session folder with raw audio but no .wav (e.g. the server was killed mid-call).
async function recoverOrphanedAudio() {
  const audioRoot = path.join(DATA_DIR, 'audio');
  if (!fs.existsSync(audioRoot)) return;

  for (const dir of fs.readdirSync(audioRoot)) {
    const dirPath = path.join(audioRoot, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath);
    if (files.some((file) => file.endsWith('.wav'))) continue;

    // Sorted file names keep a stable channel order when interleaving.
    const rawFiles = listRawFiles(dirPath);
    if (rawFiles.length === 0) continue;

    const wavFile = path.join(dirPath, `${dir.slice(dir.indexOf('_') + 1)}.wav`);
    try {
      await saveWav(rawFiles, wavFile);
      console.log(`Recovered WAV (${rawFiles.length} channel(s)): ${wavFile}`);
    } catch (error) {
      console.error(`Could not recover audio in ${dirPath}:`, error.message);
    }
  }
}

// Folder names are `<timestamp>_<call_id>`; the call_id is the segment after the timestamp.
function findCallDir(callId) {
  const audioRoot = path.join(DATA_DIR, 'audio');
  if (!fs.existsSync(audioRoot)) return null;
  const match = fs.readdirSync(audioRoot).find((entry) => entry.split('_')[1] === safeFileName(callId));
  return match ? path.join(audioRoot, match) : null;
}

// Every .raw file in a call folder, in sorted (stable channel) order, skipping empty and temp files.
function listRawFiles(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.raw') && !file.endsWith('.interleaved.raw'))
    .sort()
    .map((file) => path.join(dir, file))
    .filter((file) => fs.statSync(file).size > 0);
}

// One folder per call_id: a new RTMS stream for the same call appends to the existing folder.
function createAudioHelper(callId, streamId) {
  let audioDir = findCallDir(callId);
  if (!audioDir) {
    const createdAt = new Date();
    const sessionName = `${createdAt.toISOString().replace(/[:.]/g, '-')}_${safeFileName(callId)}`;
    audioDir = path.join(DATA_DIR, 'audio', sessionName);
    fs.mkdirSync(audioDir, { recursive: true });
  }

  const wavFile = path.join(audioDir, `${safeFileName(callId)}.wav`);
  const channels = new Map(); // channel_id -> { rawFile, stream }

  // One raw file per Zoom channel_id. Reuses the existing file for that channel if the call already has one.
  function getChannel(channelId, name) {
    let channel = channels.get(channelId);
    if (!channel) {
      const suffix = `_${safeFileName(channelId)}.raw`;
      const existing = fs.readdirSync(audioDir).find((file) => file.endsWith(suffix));
      const rawFile = path.join(audioDir, existing || `${safeFileName(name)}${suffix}`);
      const stream = fs.createWriteStream(rawFile, { flags: 'a' });
      stream.on('error', (error) => console.error(`Audio file error for ${streamId} (${channelId}):`, error.message));
      channel = { rawFile, stream };
      channels.set(channelId, channel);
      console.log(`RTMS audio opened for ${streamId}: ${name} (${channelId})`);
    }
    return channel;
  }

  let closePromise;

  return {
    wavFile,
    writeAudio(audioBuffer, channelId, name = 'Unknown') {
      getChannel(channelId, name).stream.write(audioBuffer);
    },
    close() {
      if (closePromise) return closePromise;

      const entries = [...channels.values()];
      closePromise = Promise.all(entries.map(({ stream }) => new Promise((resolve) => stream.end(resolve))))
        .then(async () => {
          const rawFiles = listRawFiles(audioDir);
          if (rawFiles.length === 0) return console.warn(`No audio received for ${streamId}; skipping WAV`);
          await saveWav(rawFiles, wavFile);
          console.log(`RTMS WAV saved for ${streamId} (${rawFiles.length} channel(s)): ${wavFile}`);
        })
        .catch((error) => console.error(`Could not finalize audio for ${streamId}:`, error.message));

      return closePromise;
    }
  };
}

module.exports = { createAudioHelper, recoverOrphanedAudio };
