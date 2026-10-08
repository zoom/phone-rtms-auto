const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const redisClient = require('./helpers/redis-client');
const { securityHeaders, validateZoomWebhook, handleZoomUrlValidation } = require('./middleware/security');
const { zoomApiRequest } = require('./helpers/zoom-api');
const { setTokens, getTokens, setActiveUserId, getActiveUserId } = require('./helpers/token-store');

// Fail fast if required secrets are missing
const requiredEnvVars = ['SESSION_SECRET', 'ZOOM_SECRET_TOKEN'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Trust proxy - required for ngrok and other reverse proxies
// This allows Express to trust X-Forwarded-* headers for proper cookie handling
app.set('trust proxy', 1);

const PORT = process.env.BACKEND_PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const FRONTEND_INTERNAL_URL = process.env.FRONTEND_INTERNAL_URL || FRONTEND_URL;
const RTMS_SERVER_URL = process.env.RTMS_SERVER_URL || 'http://localhost:3002';

// Middleware - IMPORTANT: Order matters!
// 1. CORS must come FIRST
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Body parsers
// capture raw body for webhook signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

// 3. Security headers AFTER CORS
app.use(securityHeaders);

// Session configuration with Redis store
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to false for ngrok testing (ngrok terminates SSL)
    httpOnly: true,
    sameSite: 'lax', // Allow cross-site requests for ngrok
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/' // Ensure cookie is sent for all paths
  }
}));

// Serve static frontend files (for production/ngrok deployment)
// Only serve static files if build directory exists (not in Docker dev mode)
const frontendBuildPath = path.join(__dirname, '../frontend/build');

if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Check authentication status
app.get('/api/auth/status', async (_req, res) => {
  const userId = await getActiveUserId();
  const tokens = userId ? await getTokens(userId) : { accessToken: null };
  const isAuthenticated = !!tokens.accessToken;

  res.json({
    authenticated: isAuthenticated,
    hasToken: !!tokens.accessToken
  });
});


// Home endpoint - serves the React app (for Zoom Marketplace)
// In Docker mode, this redirects to root which is proxied to frontend
app.get('/api/home', (req, res) => {
  // Redirect to root - the proxy will handle serving the frontend
  res.redirect('/');
});

// OAuth: Login - redirects to Zoom authorization page
app.get('/api/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const zoomAuthUrl = `${process.env.ZOOM_HOST || 'https://zoom.us'}/oauth/authorize`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOOM_APP_CLIENT_ID,
    redirect_uri: process.env.ZOOM_REDIRECT_URL || `${process.env.PUBLIC_URL}/api/auth/callback`,
    state
  });

  // Save session before redirecting to ensure state is persisted before the browser leaves
  req.session.save((err) => {
    if (err) console.error('Session save error:', err);
    res.redirect(`${zoomAuthUrl}?${params.toString()}`);
  });
});

// OAuth: Callback endpoint
app.get('/api/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  // Validate state for flows initiated via /api/auth/login (CSRF protection).
  // Zoom Marketplace-initiated installs arrive without a session state — allow them through.
  if (req.session.oauthState) {
    if (state !== req.session.oauthState) {
      return res.status(403).send('Invalid OAuth state');
    }
    delete req.session.oauthState;
  }

  try {
    const tokenUrl = `${process.env.ZOOM_HOST || 'https://zoom.us'}/oauth/token`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: process.env.ZOOM_REDIRECT_URL || `${process.env.PUBLIC_URL}/api/auth/callback`
    });

    const authHeader = Buffer.from(
      `${process.env.ZOOM_APP_CLIENT_ID}:${process.env.ZOOM_APP_CLIENT_SECRET}`
    ).toString('base64');

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token, expires_in, scope, token_type } = response.data;

    // Fetch the Zoom user ID to key tokens per-user
    const userResponse = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });
    const userId = userResponse.data.id;

    // Store tokens keyed by user ID (session cookies don't work in Zoom iframe)
    await setTokens(userId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ((expires_in || 3600) * 1000)
    });

    await setActiveUserId(userId);

    // Redirect back to app with success indicator
    const redirectUrl = new URL(process.env.FRONTEND_URL || 'http://localhost:3000');
    redirectUrl.searchParams.set('auth', 'success');
    res.redirect(redirectUrl.toString());
  } catch (error) {
    console.error('OAuth callback error - Full error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      stack: error.stack
    });
    const redirectUrl = new URL(process.env.FRONTEND_URL || 'http://localhost:3000');
    redirectUrl.searchParams.set('auth', 'error');
    redirectUrl.searchParams.set('error_message', encodeURIComponent(error.message));
    res.redirect(redirectUrl.toString());
  }
});

// SSE clients receiving keyword/prompt events
const sseClients = new Set();

// SSE endpoint - frontend connects here to receive real-time events
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // stop proxies (nginx etc.) from buffering the stream
  res.flushHeaders();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Internal endpoint: the RTMS service posts keyword/prompt events here; relayed to the UI over SSE.
// This server is exposed publicly, so the shared token is required.
app.post('/internal/rtms-events', (req, res) => {
  const expected = process.env.SESSION_SECRET;
  const provided = req.get('x-internal-token') || '';
  const valid = expected
    && provided.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) return res.status(401).json({ message: 'Unauthorized.' });

  const { type, call_id, ruleId, keyword, prompt, text, keywords, speaker, summary } = req.body || {};
  if (type !== 'prompt' && type !== 'keywords' && type !== 'transcript' && type !== 'summary') return res.status(400).json({ message: 'Unknown event type.' });

  const data = JSON.stringify({ type, callId: call_id, ruleId, keyword, prompt, text, keywords, speaker, summary });
  for (const client of sseClients) client.write(`data: ${data}\n\n`);
  res.status(200).json({ received: true });
});

// Webhook endpoint for Zoom events
app.post('/api/webhooks/zoom', (req, res, next) => {
  console.log(`Zoom webhook received: ${req.body?.event || 'unknown'}`);
  next();
}, validateZoomWebhook, async (req, res) => {

  if (handleZoomUrlValidation(req, res)) return;

  const { event, payload } = req.body;
  console.log(
    `Zoom webhook event received: ${event || 'unknown'}`,
    JSON.stringify(payload, null, 2)
  );

  if (event === 'phone.call_rtms_started' || event === 'phone.call_rtms_stopped') {
    const action = event === 'phone.call_rtms_started' ? 'start' : 'stop';
    try {
      await axios.post(`${RTMS_SERVER_URL}/internal/${action}`, { payload }, { timeout: 2000 });
    } catch (error) {
      console.error(`Failed to forward ${event} to RTMS service:`, error.message);
      return res.status(502).json({ message: 'RTMS service unavailable.' });
    }
  }

  res.status(200).json({ message: 'Authorized request to Zoom Webhook.', status: 200 });
});

// Proxy endpoint for Zoom API calls with automatic token refresh
app.all('/api/zoom/*zoomPath', async (req, res) => {
  const userId = await getActiveUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tokens = await getTokens(userId);
  if (!tokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const zoomPath = req.path.replace('/api/zoom/', '');
  const zoomUrl = `https://api.zoom.us/v2/${zoomPath}`;

  try {
    const data = await zoomApiRequest({
      method: req.method,
      url: zoomUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      data: req.body,
      params: req.query
    }, tokens, userId);

    res.json(data);
  } catch (error) {
    console.error('Zoom API proxy error:', error.response?.data || error.message);

    // If authentication failed after refresh attempt, return 401
    if (error.message === 'Authentication failed - please re-authenticate') {
      return res.status(401).json({
        error: 'Authentication expired',
        message: 'Please re-authenticate with Zoom',
        needsAuth: true
      });
    }

    res.status(error.response?.status || 500).json({
      error: 'Zoom API request failed',
      details: error.response?.data || error.message
    });
  }
});

// Proxy all other requests to frontend React dev server (Docker mode)
// This allows the backend to serve as single entry point
app.use('/', createProxyMiddleware({
  target: FRONTEND_INTERNAL_URL,
  changeOrigin: true,
  ws: true, // Proxy websockets for React hot reload
  logLevel: 'silent',
  onError: (err, req, res) => {
    console.log('Proxy error:', err.message);
    res.writeHead(500, {
      'Content-Type': 'text/plain',
    });
    res.end('Frontend proxy error. Is the frontend container running?');
  }
}));

// Start server
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`Public URL: ${process.env.PUBLIC_URL || 'http://localhost:3001'}`);
  console.log(`Frontend proxy: ${FRONTEND_INTERNAL_URL}`);
});
