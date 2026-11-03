# Zoom Phone RTMS Sample App

This Zoom App brings real-time call context, call transcript, call summary and live keyword prompts directly into the Zoom Phone client. This app enables users to:
- Access live call metadata inside the Zoom client
- View the call transcript as it streams in
- See a call summary every 30 seconds
- Get live keywords and suggested agent prompts as the conversation unfolds
- Stay in the Zoom client throughout the call

## Features

- Real-time Zoom Phone call context
- Live call transcript, streamed to the panel by speaker and saved to a file per call
- Live keyword chips and suggested agent prompts
- Rolling call summary, with one new bullet every 30 seconds
- Secure OAuth 2.0 authentication
- Automatic token refresh
- Per-user Redis-based token storage
- Docker-based local development
- Separate RTMS service for real-time Zoom Phone transcripts

## Prerequisites

- Zoom account with a Zoom Phone License
- Node.js (v18+ recommended)
- [Ngrok](https://ngrok.com/docs/getting-started)
- Docker and Docker Compose installed

## Getting Started

### 1. Clone Repository and Setup Environment

In your terminal:
```bash
git clone <your-repo-url>
cd ZP-rtms-auto
```

Create your environment file:
```bash
cp .env.example .env
```

Start ngrok to expose the backend:
```bash
ngrok http 3001
```

Copy the HTTPS forwarding URL and update your `.env` file:
```bash
PUBLIC_URL=https://your-ngrok-url.ngrok-free.app
ZOOM_REDIRECT_URL=https://your-ngrok-url.ngrok-free.app/api/auth/callback
```

Keep ngrok running. If the URL changes, update `.env` and the Zoom Marketplace settings.

### 2. Create Your Zoom App

1. Go to the [Zoom App Marketplace](https://marketplace.zoom.us/)
2. Click **Develop → Build App**
3. Select **General App** as the app type (note: the app must be user-managed)
4. Fill in basic information:
   - **App name:** Your app name
   - **Redirect URL for OAuth:** `https://your-ngrok-url.ngrok-free.app/api/auth/callback`

### 3. Configure Event Subscriptions

Under **Access**:
1. Turn on **Event Subscription**
2. Select **Webhook** as the delivery method and give the subscription a name.
3. Subscribe to these Phone RTMS events:
   - RTMS started in Zoom Phone
   - RTMS stopped in Zoom Phone
   - RTMS interrupted in Zoom Phone
4. Set the notification URL to: `https://your-ngrok-url.ngrok-free.app/api/webhooks/zoom`

### 4. Surface Your App

This sample is built to run as a Surface app in the Zoom client. Under **Surface**:

   - Add your **Home URL:** `https://your-ngrok-url.ngrok-free.app/api/home`
   - Add Domain Allow list:
     - `your-ngrok-url.ngrok-free.app`
     - `appssdk.zoom.us`
   - Select **Phone** as the product this app works with
   - Enable **Zoom Apps SDK** and add the following APIs:
     - `getPhoneContext`
     - `getRunningContext`

### 5. Add Scopes

Under **Scopes**, add:
- `phone:read:voice_call_audio`
- `phone:read:voice_call_transcript`
- `rtms:read:phone_rtms_stopped`
- `rtms:read:phone_rtms_interrupted`
- `rtms:read:phone_rtms_started`
- `user:read:user`

### 6. Configure App Credentials

1. In the **App Credentials** tab, copy the Client ID and Client Secret into `ZOOM_APP_CLIENT_ID` and `ZOOM_APP_CLIENT_SECRET`.
2. In the **Access** menu, copy the Secret Token into `ZOOM_SECRET_TOKEN`.
3. Set `SESSION_SECRET` to a random string. Use the same value for the backend and RTMS services.

### 7. Start the Services

```bash
docker compose up
```

The app will be available at: `http://localhost:3001`

### 8. Authorize the App

Open the login URL in a browser to start the OAuth flow:

```
https://your-ngrok-url.ngrok-free.app/api/auth/login
```

After you authorize, Zoom redirects to `/api/auth/callback`, which stores your tokens in Redis. You can then open the app inside the Zoom client.

## Usage

1. Open the app in the Zoom Phone client during a call.
2. Review the live call context (call ID, ringing and answer time).
3. Follow the live transcript in the panel as the call happens.
4. Watch for live keywords and suggested prompts.
5. Check the call summary for a new bullet every 30 seconds.

## How RTMS Works

RTMS starts when Zoom sends `phone.call_rtms_started` for a call and stops when it sends `phone.call_rtms_stopped`.

- **During the call:** The RTMS service opens audio and transcript connections. Transcript lines and summary bullets update live in the panel.
- **When the call ends:** The backend forwards `phone.call_rtms_stopped`, RTMS closes its connections, and the raw audio is combined into a WAV file.

### Output Files

- **Audio:** `rtms/data/audio/<timestamp>_<callId>/<callId>.wav`. Each speaker channel is first saved as a raw PCM file (`ch00_<channel>.raw`, and so on). The WAV is 16 kHz, 16-bit: mono for one channel, or interleaved channels for several. The RTMS image includes FFmpeg for the conversion.
- **Transcripts:** `rtms/data/transcripts/<timestamp>_<callId>.txt`. Each line has the form `[mm:ss] Speaker: text`, with the offset from the first message.

## Production Security

- **Do not store credentials in plain-text `.env` files in production.** Use a secrets manager. The `.env` file is for local development only and is git-ignored by default.
- Review the Content Security Policy in `backend/middleware/security.js` before deploying.
- Tokens are stored per user in Redis. Secure your Redis instance and keep it off the public internet.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Support

Find us in the [Zoom Developer Forum](https://devforum.zoom.us/).
