# Zoom Phone RTMS Sample App

This Zoom App brings real-time call context, call transcript, call summary and live keyword prompts directly into the Zoom Phone client. This app enables users to:
- Access live call metadata inside the Zoom client
- View the call transcript as it streams in
- See a call summary every 30 seconds
- Get live keywords and suggested agent prompts as the conversation unfolds
- Stay in the Zoom client throughout the call

## Features

- Real-time Zoom Phone call context 
- Live call transcript streaming
- Rolling call summary updated every 30 seconds
- Live keyword detection and suggested agent prompts
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

### 4. Surface your App

This sample is built to run as a Surface app in the Zoom client. Under **Surface**:

   - Add your **Home URL:** `https://your-ngrok-url.ngrok-free.app/api/home`
   - Add Domain Allow list:
     - `your-ngrok-url.ngrok-free.app.app`
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
docker-compose up
```

The app will be available at: `http://localhost:3001`

### 8. Authorize the App

Open the login URL in a browser to start the OAuth flow:

```
https://your-ngrok-url.ngrok-free.app/api/auth/login
```

After you authorize, Zoom redirects to `/api/auth/callback`, which stores your tokens in Redis. You can then open the app inside the Zoom client.


## Configure and Run Zoom Phone RTMS

Follow these steps to start a Phone RTMS stream, receive audio and transcript packets, and close the stream when the call ends.

1. **Enable RTMS for your app and account.** Configure the app for Phone RTMS access to both audio and transcripts. The RTMS service expects both media types. Grant the RTMS media permissions available for your app and account.

2. **Confirm the webhook path.** Zoom sends `phone.call_rtms_started` and `phone.call_rtms_stopped` to `https://<public-host>/api/webhooks/zoom`. The backend validates the signature using `ZOOM_SECRET_TOKEN` and forwards the payload to the RTMS service.

3. **Start a Phone RTMS call.** Place or answer a call that starts RTMS for this app. The start event includes `call_id`, `rtms_stream_id`, and signaling `server_urls`. The RTMS service connects to the signaling URL, then opens separate audio and transcript media connections.

4. **Watch the logs:**

   ```bash
   docker compose logs -f backend rtms
   ```

   The RTMS log reports audio progress every 100 audio packets and prints transcript messages as they arrive.

5. **Stop the stream.** End the call or otherwise trigger `phone.call_rtms_stopped`. The backend forwards the event, and RTMS closes its sockets. Output files are written to `rtms/data/`:
   - **Audio** is saved to `rtms/data/audio/<timestamp>_<callId>/`. Each speaker channel is written as a raw PCM file (`ch00_<channel>.raw`, `ch01_<channel>.raw`, and so on). When the call ends, these are combined into a single `<callId>.wav` in the same folder: 16 kHz, 16-bit, mono for one channel, or interleaved multi-channel for several. The RTMS image includes FFmpeg for this conversion.
   - **Transcripts** are written to one plain-text file per call, `rtms/data/transcripts/<timestamp>_<callId>.txt`. Each line has the form `[mm:ss] Speaker: text`, where the time is the offset from the first message. The file starts with the call ID, stream ID, and start time. Speakers use the name Zoom provides, or `Speaker 1`, `Speaker 2`, and so on by channel.

`rtms/data/` is excluded from version control.

## Live Call Transcript

The RTMS service streams each transcript message to the Zoom App panel as it arrives, labeled by speaker. It also writes the same lines to `rtms/data/transcripts/<timestamp>_<callId>.txt` with a `[mm:ss]` offset.

## Keyword Detection and Prompts

The RTMS service scans each transcript message in real time, using rules in `rtms/keywords.json`:

- **Prompts:** When a rule's keyword or phrase appears, its prompt appears in the panel. `cooldownSeconds` prevents repeats.
- **Live keywords:** The most frequent non-stopword terms appear as chips.

## Call Summary

Every 30 seconds, the RTMS service adds one bullet to the panel summarizing the transcript from that window, using its most repeated topic words and a representative sentence. Windows with no usable speech add nothing. Summaries are kept in memory for the call and are not saved to disk. Settings are in `rtms/summarizer.js`.

## Usage

1. Open the app in the Zoom Phone client during a call.
2. Review the live call context (call ID, ringing and answer time).
3. Follow the **Live Transcript** section for the call as it happens.
4. Watch the **Keyword Detection** section for live keywords and suggested prompts.
5. Check the **Call Summary** section for a new bullet every 30 seconds.

## Troubleshooting

**Webhooks not arriving**
- Confirm ngrok is running.
- Make sure the ngrok URL matches in `.env` and in Zoom Marketplace.
- Confirm the notification URL is `https://your-ngrok-url.ngrok-free.app/api/webhooks/zoom`.

**Prompts or keywords not appearing**
- Confirm `SESSION_SECRET` is set and identical for the `backend` and `rtms` services.
- Check RTMS logs: `docker compose logs -f rtms`

**"Not authenticated" or API errors**
- Complete the OAuth flow at `/api/auth/login`.
- Check backend logs: `docker compose logs -f backend`
- If you see "Authentication expired," reauthorize the app.

**Services not running**
- Check container status: `docker compose ps`
- View all logs: `docker compose logs -f`

## OAuth Authentication and Token Storage

The app uses OAuth 2.0 with automatic token refresh.

### How It Works

1. **Initial authentication.** Open `/api/auth/login` in a browser, as described in [Getting Started](#8-authorize-the-app). After you authorize, tokens are stored server-side in Redis, keyed by user ID.
2. **Why Redis?** Zoom Apps run in an iframe inside the Zoom client, and modern browsers block third-party cookies in iframes. Tokens are stored on the server instead, scoped per user.
3. **Identifying the user.** The app gets the user ID from the Zoom Apps SDK context, then uses it to look up that user's tokens in Redis.

```
OAuth callback → GET /users/me → Redis (key: "oauth:tokens:{userId}")
                                          ↓
Zoom App (iframe) → API request → look up tokens in Redis by userId
```

### Automatic Token Refresh

When an access token expires (a 401 response), the app:

1. Uses the refresh token to get a new access token.
2. Updates Redis with the new tokens.
3. Retries the failed request.

No user action is required.

### Re-authentication

If the refresh token expires, you'll see a "Not authenticated" error. Reinstall or reauthorize the app from the Zoom Marketplace.

## Production Security

- **Do not store credentials in plain-text `.env` files in production.** Use a secrets manager. The `.env` file is for local development only and is git-ignored by default.
- Review the Content Security Policy in `backend/middleware/security.js` before deploying.
- Tokens are stored per user in Redis. Secure your Redis instance and keep it off the public internet.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Support

Find us in the [Zoom Developer Forum](https://devforum.zoom.us/).