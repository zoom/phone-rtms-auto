const crypto = require('crypto');
const WebSocket = require('ws');

const CLIENT_ID = process.env.RTMS_ZOOM_CLIENT_ID || process.env.ZOOM_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.RTMS_ZOOM_CLIENT_SECRET || process.env.ZOOM_APP_CLIENT_SECRET;

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

module.exports = { generateSignature, send };
