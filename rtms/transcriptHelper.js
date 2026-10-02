const fs = require('fs');
const path = require('path');

const TRANSCRIPT_DIR = path.join(__dirname, 'data', 'transcripts');

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

// Writes one readable transcript file per call:
//   [00:03] Speaker 1: Hello!
function createTranscriptHelper(callId, streamId) {
  const createdAt = new Date();
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const transcriptFile = path.join(TRANSCRIPT_DIR, `${stamp}_${safeFileName(callId)}.txt`);
  const stream = fs.createWriteStream(transcriptFile, { flags: 'a' });
  stream.on('error', (error) => console.error(`Transcript file error for ${streamId}:`, error.message));

  stream.write([
    `Call ID:   ${callId}`,
    `Stream ID: ${streamId}`,
    `Started:   ${createdAt.toISOString()}`,
    '-'.repeat(60),
    '',
    ''
  ].join('\n'));

  const speakers = new Map(); // channel_id -> "Speaker N"
  let firstStartTime;

  return {
    transcriptFile,
    writeTranscript(content) {
      const text = content?.data?.trim();
      if (!text) return;

      if (!speakers.has(content.channel_id)) speakers.set(content.channel_id, `Speaker ${speakers.size + 1}`);
      const speaker = speakers.get(content.channel_id);

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
