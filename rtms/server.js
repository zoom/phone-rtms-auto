const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const WebSocket = require('ws');
const { recoverOrphanedAudio } = require('./features/audio');
const { notify } = require('./lib/eventNotifier');
const { generateSignature, send } = require('./lib/rtmsAuth');
const { sessions, handleRTMSStart, handleRTMSStop } = require('./lib/rtmsSession');

const app = express();
const PORT = 3002;
const AUDIO_SEND_RATE_MS = 20;

app.use(express.json());

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

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'zoom-rtms', activeStreams: sessions.size });
});

// Zoom Phone RTMS events, forwarded by the backend after it validates the webhook.
app.post('/', (req, res) => {
  const { event, payload } = req.body || {};

  if (event === 'phone.call_rtms_started') {
    handleRTMSStart(payload, connectToSignalingWebSocket);
  } else if (event === 'phone.call_rtms_stopped') {
    handleRTMSStop(payload?.rtms_stream_id);
  }
  res.status(200).json({ received: true });
});

const server = app.listen(PORT, () => {
  console.log(`Zoom RTMS server listening on port ${PORT}`);
  console.log('RTMS event endpoint: POST /');
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
