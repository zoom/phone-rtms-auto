const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(__dirname, 'data');

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function createAudioHelper(callId, streamId) {
  const createdAt = new Date();
  const sessionName = `${createdAt.toISOString().replace(/[:.]/g, '-')}_${safeFileName(callId)}`;
  const audioDir = path.join(DATA_DIR, 'audio', sessionName);
  const transcriptDir = path.join(DATA_DIR, 'transcripts');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });

  const audioFile = path.join(audioDir, `${safeFileName(callId)}.raw`);
  const wavFile = path.join(audioDir, `${safeFileName(callId)}.wav`);
  const transcriptFile = path.join(transcriptDir, `${createdAt.toISOString().slice(0, 10)}.txt`);
  const audioStream = fs.createWriteStream(audioFile, { flags: 'a' });
  const transcriptStream = fs.createWriteStream(transcriptFile, { flags: 'a' });

  audioStream.on('error', (error) => console.error(`Audio file error for ${streamId}:`, error.message));
  transcriptStream.on('error', (error) => console.error(`Transcript file error for ${streamId}:`, error.message));

  let closePromise;

  return {
    audioFile,
    wavFile,
    transcriptFile,
    writeAudio(content) {
      if (!content?.data) return;
      audioStream.write(Buffer.from(content.data, 'base64'));
    },
    writeTranscript(content) {
      const entry = {
        timestamp: new Date().toISOString(),
        call_id: callId,
        rtms_stream_id: streamId,
        content
      };
      transcriptStream.write(`${JSON.stringify(entry)}\n`);
    },
    close() {
      if (closePromise) return closePromise;

      closePromise = Promise.all([
        new Promise((resolve) => audioStream.end(resolve)),
        new Promise((resolve) => transcriptStream.end(resolve))
      ]).then(async () => {
        await execFileAsync('ffmpeg', [
          '-y',
          '-f', 's16le',
          '-ar', '16000',
          '-ac', '1',
          '-i', audioFile,
          wavFile
        ]);
        console.log(`RTMS WAV saved for ${streamId}: ${wavFile}`);
      }).catch((error) => {
        console.error(`Could not finalize audio for ${streamId}:`, error.message);
      });

      return closePromise;
    }
  };
}

module.exports = { createAudioHelper };
