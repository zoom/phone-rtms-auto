const fs = require('fs');
const path = require('path');

// Runtime output lives in rtms/data, which is gitignored.
const TRANSCRIPT_DIR = path.join(__dirname, '..', '..', 'data', 'transcripts');

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// 65432 ms -> "01:05"
function formatOffset(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// File names are `<timestamp>_<call_id>.txt`; the call_id is the segment after the timestamp.
function findTranscriptFile(callId) {
  if (!fs.existsSync(TRANSCRIPT_DIR)) return null;
  const match = fs.readdirSync(TRANSCRIPT_DIR)
    .find((file) => file.split('_')[1]?.replace(/\.txt$/, '') === safeFileName(callId));
  return match ? path.join(TRANSCRIPT_DIR, match) : null;
}

// Writes one readable transcript file per call_id:
//   [00:03] Rehema Armorer: Hello!
// A new RTMS stream for the same call appends to the existing file.
function createTranscriptHelper(callId, streamId) {
  const createdAt = new Date();
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  const existingFile = findTranscriptFile(callId);
  const transcriptFile = existingFile
    || path.join(TRANSCRIPT_DIR, `${createdAt.toISOString().replace(/[:.]/g, '-')}_${safeFileName(callId)}.txt`);
  const stream = fs.createWriteStream(transcriptFile, { flags: 'a' });
  stream.on('error', (error) => console.error(`Transcript file error for ${streamId}:`, error.message));

  if (!existingFile) {
    stream.write([
      `Call ID:   ${callId}`,
      `Stream ID: ${streamId}`,
      `Started:   ${createdAt.toISOString()}`,
      '-'.repeat(60),
      '',
      ''
    ].join('\n'));
  }

  let firstStartTime;

  return {
    transcriptFile,
    writeTranscript(content, speaker = 'Unknown') {
      const text = content?.data?.trim();
      if (!text) return;

      if (firstStartTime === undefined && content.start_time) firstStartTime = content.start_time;
      const offset = content.start_time && firstStartTime !== undefined
        ? formatOffset(content.start_time - firstStartTime)
        : '--:--';

      stream.write(`[${offset}] ${speaker}: ${text}\n`);
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    }
  };
}

module.exports = { createTranscriptHelper };
