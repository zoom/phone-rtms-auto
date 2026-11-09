const { createAudioHelper } = require('../features/audio');
const { createTranscriptHelper } = require('../features/transcript');
const { createKeywordDetector } = require('../features/keyword-detector');
const { createSummarizer } = require('../features/summarizer');
const { notify } = require('./eventNotifier');

// One RTMS stream has one signaling socket and separate audio/transcript sockets.
const sessions = new Map();

// `connect(serverUrl, session)` opens the signaling socket. It is passed in because the socket
// handlers call handleRTMSStop, and importing them here would make the two files circular.
function handleRTMSStart(payload, connect) {
  console.log('IN FUNCTION START')
  const { call_id, rtms_stream_id, server_urls } = payload || {};
  if (!call_id || !rtms_stream_id || !server_urls) {
    console.error('Invalid phone.call_rtms_started payload.');
    return;
  }
  if (sessions.has(rtms_stream_id)) return;

  const streamId = rtms_stream_id;
  // Payloads can carry suffixed ids (e.g. "06af..._1"); the base id before the first "_" identifies the call.
  // The original call_id stays on the session because the signaling handshake signs it.
  const baseCallId = String(call_id).split('_')[0];
  const session = {
    call_id,
    streamId,
    signaling: null,
    audio: null,
    transcript: null,
    audioChunkCount: 0,
    audioHelper: createAudioHelper(baseCallId, streamId),
    transcriptHelper: createTranscriptHelper(baseCallId, streamId),
    keywordDetector: createKeywordDetector(),
    summarizer: createSummarizer(),
    stopped: false
  };
  sessions.set(streamId, session);
  session.summarizer.start((event) => notify(session, event));
  connect(server_urls, session);
}

function handleRTMSStop(streamId, reason = 'stopped by Zoom') {
  const session = sessions.get(streamId);
  if (!session) return;

  session.stopped = true;
  sessions.delete(streamId);
  session.audioHelper?.close();
  session.transcriptHelper?.close();
  session.summarizer?.stop();
  for (const socket of [session.audio, session.transcript, session.signaling]) {
    socket?.close(1000, reason);
  }
  console.log(`RTMS stream ${streamId} ended and cleaned up.`);
}

module.exports = { sessions, handleRTMSStart, handleRTMSStop };
