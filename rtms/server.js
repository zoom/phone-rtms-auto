const crypto = require('crypto');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const { createAudioHelper, recoverOrphanedAudio } = require('./audioHelper');
const { createTranscriptHelper } = require('./transcriptHelper');
const { createKeywordDetector } = require('./keywordDetector');
const { createSummarizer } = require('./summarizer');
const { notify } = require('./eventNotifier');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = Number(process.env.RTMS_PORT || 3002);
const AUDIO_SEND_RATE_MS = 20;
const CLIENT_ID = process.env.RTMS_ZOOM_CLIENT_ID || process.env.ZOOM_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.RTMS_ZOOM_CLIENT_SECRET || process.env.ZOOM_APP_CLIENT_SECRET;

for (const [name, value] of Object.entries({ CLIENT_ID, CLIENT_SECRET })) {
  if (!value) {
    throw new Error(`Missing RTMS configuration: ${name}. Set the RTMS_ZOOM_* variables in .env.`);
  }
}

app.use(express.json());

// One RTMS stream has one signaling socket and separate audio/transcript sockets.
const sessions = new Map();

function generateSignature(call_id, streamId) {
  // console.log('SIGNATURE', call_id, streamId)
  return crypto
    .createHmac('sha256', CLIENT_SECRET)
    .update(`${CLIENT_ID},${call_id},${streamId}`)
    .digest('hex');
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, reason);
  }
  console.log(`RTMS stream ${streamId} ${reason}`);
}

function connectToMediaWebSocket(mediaUrl, session, mediaType) {
  const socketKey = mediaType === 1 ? 'audio' : 'transcript';
  if (!mediaUrl || session[socketKey] || session.stopped) return;

  const media = new WebSocket(mediaUrl);
  session[socketKey] = media;

  media.on('open', () => {
    console.log(`RTMS media connected for ${session.call_id}`);
    send(media, {
      msg_type: 3, // DATA_HAND_SHAKE_REQ
      protocol_version: 2, // must use 2
      sequence: 0,
      call_id: session.call_id,
      rtms_stream_id: session.streamId,
      signature: generateSignature(session.call_id, session.streamId),
      media_type: mediaType,
      ...(mediaType === 1
        ? { media_params: { audio: { send_rate: AUDIO_SEND_RATE_MS } } }
        : {})
    });
  });

  media.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      console.warn(`Ignoring non-JSON RTMS media packet for ${session.streamId}`);
      return;
    }

    if (message.msg_type === 4) { // DATA_HAND_SHAKE_RESP
      if (message.status_code !== 0) {
        console.error(`RTMS media handshake failed for ${session.streamId}:`, message.reason);
        return handleRTMSStop(session.streamId, 'media handshake failed');
      }
      // console.log(`RTMS media handshake complete for ${session.call_id}`);
      send(session.signaling, {
        msg_type: 7, // CLIENT_READY_ACK
        rtms_stream_id: session.streamId,
        media_type: mediaType
      });
    } else if (message.msg_type === 12) { // KEEP_ALIVE_REQ
      send(media, { msg_type: 13, timestamp: message.timestamp }); // KEEP_ALIVE_RESP
    }else if (mediaType === 8 && message.msg_type === 17) { // MEDIA_DATA_TRANSCRIPT
      for (const event of session.keywordDetector.process(message.content)) notify(session, event);
      session.summarizer.process(message.content);
      const text = message.content?.data?.trim();
      if (text) notify(session, { type: 'transcript', speaker: session.transcriptHelper.speakerFor(message.content), text });
      session.transcriptHelper.writeTranscript(message.content);
      console.log('RTMS transcript:', JSON.stringify({
        call_id: session.call_id,
        streamId: session.streamId,
        content: message.content
      }));
    } else if (mediaType === 1 && message.msg_type === 14) { // MEDIA_DATA_AUDIO
      if (!message.content?.data) return;
      const audioBuffer = Buffer.from(message.content.data, 'base64');
      session.audioHelper.writeAudio(audioBuffer, message.content.channel_id);
      session.audioChunkCount++;

      if (session.audioChunkCount % 100 === 0) {
        console.log(`🎵 Audio chunks: ${session.audioChunkCount} (channel_id: ${message.content.channel_id})`);
      }
    }
  });

  media.on('error', (error) => console.error(`RTMS media error for ${session.streamId}:`, error.message));
  media.on('close', (code) => {
    if (!session.stopped) handleRTMSStop(session.streamId, `${socketKey} socket closed (${code})`);
  });
}

function connectToSignalingWebSocket(serverUrl, session) {
  const { call_id, streamId } = session;
  const signaling = new WebSocket(serverUrl);
  session.signaling = signaling;

  signaling.on('open', () => {
    console.log(`RTMS signaling connected for call ${call_id}`);
    send(signaling, {
      msg_type: 1, // SIGNALING_HAND_SHAKE_REQ
      protocol_version: 2, // must use 2
      sequence: 0,
      call_id: call_id,
      rtms_stream_id: streamId,
      signature: generateSignature(call_id, streamId)
    });
  });

  signaling.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
      console.log(`message type`, message.msg_type)
    } catch {
      console.warn(`Ignoring non-JSON RTMS signaling packet for ${streamId}`);
      return;
    }

    if (message.msg_type === 2) { // SIGNALING_HAND_SHAKE_RESP
      console.log(`!!!!!!!!!!RTMS signaling handshake response for ${streamId}:`, message);
      if (message.status_code !== 0) {
        console.error(`RTMS signaling handshake failed for ${streamId}:`, message.reason);
        return handleRTMSStop(streamId, 'signaling handshake failed');
      }
      // server_urls values are comma-separated (e.g. "wss://...,srt://..."); keep only the wss link
      const pickWssUrl = (urls) => String(urls || '').split(',').map(u => u.trim()).find(u => u.startsWith('wss://'));
      const audioUrl = pickWssUrl(message.media_server?.server_urls?.audio);
      const transcriptUrl = pickWssUrl(message.media_server?.server_urls?.transcript);
      if (!audioUrl || !transcriptUrl) {
        return handleRTMSStop(streamId, 'audio or transcript stream unavailable');
      }
      connectToMediaWebSocket(audioUrl, session, 1); // AUDIO
      connectToMediaWebSocket(transcriptUrl, session, 8); // TRANSCRIPT
    } else if (message.msg_type === 12) { // KEEP_ALIVE_REQ
      send(signaling, { msg_type: 13, timestamp: message.timestamp }); // KEEP_ALIVE_RESP
    } else if (message.msg_type === 6) {
      console.log('EVENT CODE TEST', JSON.stringify(message, null, 2))
    }
  });

  signaling.on('error', (error) => console.error(`RTMS signaling error for ${streamId}:`, error.message));
  signaling.on('close', (code) => {
    if (!session.stopped) handleRTMSStop(streamId, `signaling socket closed (${code})`);
  });
}

function handleRTMSStart(payload) {
  console.log('IN FUNCTION START')
  const { call_id, rtms_stream_id, server_urls } = payload || {};
  if (!call_id || !rtms_stream_id || !server_urls) {
    console.error('Invalid phone.call_rtms_started payload.');
    return;
  }
  if (sessions.has(rtms_stream_id)) return;

  const streamId = rtms_stream_id;
  const session = {
    call_id,
    streamId,
    signaling: null,
    audio: null,
    transcript: null,
    audioChunkCount: 0,
    audioHelper: createAudioHelper(call_id, streamId),
    transcriptHelper: createTranscriptHelper(call_id, streamId),
    keywordDetector: createKeywordDetector(),
    summarizer: createSummarizer(),
    stopped: false
  };
  sessions.set(streamId, session);
  session.summarizer.start((event) => notify(session, event));
  connectToSignalingWebSocket(server_urls, session);
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'zoom-rtms', activeStreams: sessions.size });
});

app.post('/internal/start', (req, res) => {
  const { payload } = req.body || {};
  if (!payload?.call_id || !payload?.rtms_stream_id || !payload?.server_urls) {
    return res.status(400).json({ message: 'Invalid phone.call_rtms_started payload.' });
  }
  handleRTMSStart(payload);
  return res.status(200).json({ received: true });
});

app.post('/internal/stop', (req, res) => {
  const streamId = req.body?.payload?.rtms_stream_id;
  if (!streamId) return res.status(400).json({ message: 'Missing rtms_stream_id.' });
  handleRTMSStop(streamId);
  return res.status(200).json({ received: true });
});

const server = app.listen(PORT, () => {
  console.log(`Zoom RTMS server listening on port ${PORT}`);
  console.log('RTMS internal control endpoints: /internal/start, /internal/stop');
});

async function shutdown() {
  const activeSessions = [...sessions.entries()];
  for (const [streamId] of activeSessions) handleRTMSStop(streamId, 'server shutting down');
  await Promise.all(activeSessions.flatMap(([, session]) => [session.audioHelper?.close(), session.transcriptHelper?.close()]));
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGUSR2', shutdown); // nodemon restart

recoverOrphanedAudio().catch((error) => console.error('Audio recovery failed:', error.message));
