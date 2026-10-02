// Pushes detection events to the backend, which relays them to the agent UI over SSE.
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:3001';
const TOKEN = process.env.SESSION_SECRET;

if (!TOKEN) {
  console.warn('SESSION_SECRET is not set; keyword prompts will be logged but not sent to the UI.');
}

async function notify(session, event) {
  console.log(`RTMS ${event.type} for ${session.call_id}:`, JSON.stringify(event));
  if (!TOKEN) return;

  try {
    const response = await fetch(`${BACKEND_URL}/internal/rtms-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': TOKEN },
      body: JSON.stringify({ call_id: session.call_id, rtms_stream_id: session.streamId, ...event }),
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) console.error(`Backend rejected ${event.type} event: ${response.status}`);
  } catch (error) {
    console.error(`Could not deliver ${event.type} event:`, error.message);
  }
}

module.exports = { notify };
