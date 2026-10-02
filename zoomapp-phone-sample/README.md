# Zoom App for Phone

A Zoom App that brings real-time call context and AI-generated summaries directly into the Zoom Phone client. This app enables users to:
- Access live call metadata inside the Zoom client
- Automatically receive AI summary IDs via secure webhooks when calls complete
- Retrieve full AI-generated summaries on demand
- Streamline documentation and post-call workflows without leaving Zoom

## Features

- Real-time Zoom Phone call context (call ID, status, duration)
- Automatic AI summary ID retrieval via webhook
- On-demand AI call summary fetching
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
git clone https://github.com/elisalevet/zoomapp-phone.git
cd zoomapp-phone
```

Create your environment file:
```bash
cp .env.example .env
```

Start ngrok:
```bash
ngrok http 3001
```

Update your `.env` file with your ngrok URL:
```bash
PUBLIC_URL=https://abc123.ngrok-free.app
ZOOM_REDIRECT_URL=https://abc123.ngrok-free.app/api/auth/callback
```

### 2. Create and Configure Your Zoom App

1. Go to the [Zoom App Marketplace](https://marketplace.zoom.us/)
2. Click **Develop → Build App → General App**
3. Name your app

#### Basic Information and App Credentials
1. Select **User-managed app**
2. Copy the client ID and client secret into your `.env` file:
   - `ZOOM_APP_CLIENT_ID`
   - `ZOOM_APP_CLIENT_SECRET`
3. Add your OAuth redirect URL: `https://abc123.ngrok-free.app/api/auth/callback`

#### Zoom App Configuration

**Features → Access**
1. Copy your app's Secret Token and add it to your `.env` file as `ZOOM_SECRET_TOKEN`
2. Create an Event subscription, give it a name, and select **Call Summary Changed**
3. Set the Event notification endpoint URL to:
   `https://abc123.ngrok-free.app/api/webhooks/zoom`
4. Save the changes

**Features → Surface**
1. Add your Home URL: `https://abc123.ngrok-free.app/api/home`
2. Add Domain Allow list:
   - `abc123.ngrok-free.app`
   - `appssdk.zoom.us`
3. Select **Phone** as the product this app works with
4. Enable **Zoom Apps SDK** and add the following APIs:
   - `getPhoneContext`
   - `getRunningContext`

> Note: You can add more APIs or events as needed for your integration.

**Scopes**

Add the required scopes:
- `phone:read:ai_call_summary`
- `phone:read:call_log`
- `user:read:user`

### 3. Start the Application

```bash
docker-compose up
```

The app will be available at: `http://localhost:3001`

### Configure and run Zoom Phone RTMS

Follow these steps to start a Phone RTMS stream, receive its audio and transcript
packets, and close the stream when the call ends.

1. **Enable RTMS for the Zoom Phone app/account.** In the Zoom App Marketplace,
   configure the app and Phone RTMS access for both audio and transcripts. This
   service expects both media types. Grant the RTMS media permissions available
   for your app and account; the separate AI summary and call-log scopes in this
   README are for the Zoom Phone UI flow, not RTMS media capture.

2. **Subscribe to the Phone RTMS events.** In the app's event subscription, add
   `phone.call_rtms_started` and `phone.call_rtms_stopped`. Set the notification
   URL to `https://<public-host>/api/webhooks/zoom`. The backend validates Zoom's
   webhook signature using the app's Secret Token, then forwards the event
   payload to the internal RTMS service.

3. **Set credentials and secrets in `.env`.** The RTMS service uses the Zoom
   Client ID and Client Secret to sign its WebSocket handshakes. Set
   `RTMS_ZOOM_CLIENT_ID` and `RTMS_ZOOM_CLIENT_SECRET` only if RTMS uses a
   different Zoom app; otherwise it uses `ZOOM_APP_CLIENT_ID` and
   `ZOOM_APP_CLIENT_SECRET`. Also set `ZOOM_SECRET_TOKEN` for webhook validation
   and `SESSION_SECRET` for the backend. The example file contains the remaining
   local stack settings.

4. **Expose the backend webhook and start the services.** Run `ngrok http 3001`,
   use its HTTPS URL as the event notification URL from step 2, then run:

   ```bash
   docker compose up --build
   ```

   Only the backend needs a public URL. RTMS listens internally on port 3002;
   Zoom does not connect directly to that port. The RTMS image includes FFmpeg
   to create the WAV file when a stream stops.

5. **Start a Phone RTMS call and confirm media arrives.** Place or answer a call
   that starts RTMS for this app. Zoom sends a start event containing `call_id`,
   `rtms_stream_id`, and signaling `server_urls`. The RTMS service connects to
   the signaling URL, then opens the separate audio and transcript media
   connections. Watch the services with:

   ```bash
   docker compose logs -f backend rtms
   ```

   The RTMS log reports audio progress every 100 audio packets and prints
   transcript messages as they arrive. Audio packets are saved as a per-call
   `.raw` file; transcripts are appended as JSON lines to
   `rtms/data/transcripts/YYYY-MM-DD.txt`.

6. **Stop the stream.** End the call or otherwise trigger
   `phone.call_rtms_stopped`. The backend forwards the stop payload, and RTMS
   closes its media and signaling sockets. It keeps the `.raw` audio and creates
   a 16 kHz mono `.wav` beside it. Audio and transcript files are under
   `rtms/data/`, which is excluded from version control.

### 4. Authorize and Test

Navigate to your login URL to begin the OAuth flow:
```
https://abc123.ngrok-free.app/api/auth/login
```

After authorizing, Zoom will redirect back to the app and open it inside the Zoom client.

## Usage

1. Open the app within the Zoom Phone client during a call
2. View live call context (call ID, status, timestamps)
3. The AI call summary ID is populated automatically via webhook when a call ends
4. Click **Get AI Summary** to fetch the summary for the current call

## Troubleshooting

**Webhooks not working?**
- Ensure ngrok is running
- Verify the ngrok URL is set in both `.env` and Zoom Marketplace
- Check the webhook URL matches: `https://your-ngrok-url.ngrok-free.app/api/webhooks/zoom`

**AI summary ID not populating?**
- Make sure you've subscribed to phone webhook events in Zoom Marketplace
- Check backend logs: `docker-compose logs -f backend`

**API errors / Not authenticated?**
- Ensure you've completed the OAuth flow
- View backend logs: `docker-compose logs -f backend`
- If you see "Authentication expired", re-authenticate the application

**Services not running?**
- Check all containers: `docker-compose ps`
- View logs: `docker-compose logs -f`

## OAuth Authentication & Token Storage

The app uses OAuth 2.0 with automatic token refresh.

### How It Works

1. **Initial Authentication**
   - Install the app from Zoom Marketplace
   - The OAuth flow opens in a new window/tab
   - After authorizing, tokens are stored server-side in Redis keyed by user ID
   - You'll be redirected back to the app

2. **Why Redis Token Storage?**
   - Zoom Apps run inside an iframe within the Zoom client
   - Modern browsers block third-party cookies in iframes
   - **Solution**: Tokens are stored in Redis on the server, scoped per user
   - All API requests from the iframe use these Redis-stored tokens

3. **Token Storage Architecture**
   ```
   OAuth Callback → fetch /users/me → Redis (key: "oauth:tokens:{userId}")
                                              ↓
   Zoom App (iframe) → API Request → Get Tokens from Redis by userId
   ```

4. **Automatic Token Refresh**
   - When an access token expires (401 error), the app automatically:
     - Uses the refresh token to get a new access token
     - Updates Redis with the new tokens
     - Retries the failed request seamlessly
   - No user interaction needed

5. **Re-authentication**
   - If the refresh token expires, you'll see a "Not authenticated" error
   - Simply reinstall/reauthorize the app from Zoom Marketplace

## Production Security

- **Do not store credentials in plain text `.env` files in production.**  Use a secrets manager. The .env file is for local development only and is git-ignored by default.
- Review the Content Security Policy in `backend/middleware/security.js` before deploying 
- Tokens are stored per user in Redis. Ensure your Redis instance is secured and not publicly accessible in production.

## License

MIT License — see [LICENSE](LICENSE) for details.

## Support

Find us in the [Zoom Developer Forum](https://devforum.zoom.us/) for support.
