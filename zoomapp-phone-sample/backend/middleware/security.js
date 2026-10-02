const crypto = require('crypto');

/**
 * Security middleware for OWASP headers and other security measures
 */

function securityHeaders(req, res, next) {
  // OWASP Security Headers (required by Zoom Apps)
  // Only apply HSTS when the connection is HTTPS (includes ngrok) — sending it over plain
  // HTTP can lock users out by instructing browsers to always use HTTPS for this host
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }


  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3001';
  const isProd = process.env.NODE_ENV === 'production';

  // Content Security Policy
  // Dev: permissive to allow localhost and ngrok hot-reload.
  // Production: tighten these directives — remove http://localhost:*, ws://localhost:*,
  // 'unsafe-inline', and 'unsafe-eval' and replace with your actual deployment origin.
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self' ${isProd ? '' : 'http://localhost:* '}${publicUrl}; ` +
    `script-src 'self' 'unsafe-inline' ${isProd ? '' : "'unsafe-eval' "}https://appssdk.zoom.us${isProd ? '' : ' http://localhost:*'}; ` +
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${isProd ? '' : ' http://localhost:*'}; ` +
    `font-src 'self' https://fonts.gstatic.com data:; ` +
    `connect-src 'self' https://*.zoom.us wss://*.zoom.us${isProd ? '' : ' http://localhost:* ws://localhost:*'} ${publicUrl}; ` +
    `img-src 'self' data: https:${isProd ? '' : ' http://localhost:*'}; ` +
    `frame-ancestors 'self' https://*.zoom.us https://applications.zoom.us;`
  );

  // X-Frame-Options - Allow Zoom to embed
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  next();
}

/**
 * Validate Zoom webhook signature
 */
function validateZoomWebhook(req, res, next) {
  // Construct the signature base string using the secret token
  const timestamp = req.headers['x-zm-request-timestamp'];
  const secretToken = process.env.ZOOM_SECRET_TOKEN.trim();
  const hmac = crypto.createHmac('sha256', secretToken);
  hmac.update(`v0:${timestamp}:`);
  hmac.update(req.rawBody);
  const signature = `v0=${hmac.digest('hex')}`;

  // Compare the generated signature with the one sent by Zoom in the headers
  if (req.headers['x-zm-signature'] !== signature) {
    console.log('Unauthorized request to Zoom Webhook.');
    return res.status(401).json({ message: 'Unauthorized request to Zoom Webhook.' });
  }

  next();
}

/**
 * Handle Zoom endpoint URL validation challenge
 * Returns true if the request was a validation challenge (response already sent), false otherwise
 */
function handleZoomUrlValidation(req, res) {
  if (req.body?.event !== 'endpoint.url_validation') return false;

  const encryptedToken = crypto
    .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN)
    .update(req.body.payload.plainToken)
    .digest('hex');

  console.log({ plainToken: req.body.payload.plainToken, encryptedToken });
  res.status(200).json({ plainToken: req.body.payload.plainToken, encryptedToken });
  return true;
}

module.exports = {
  securityHeaders,
  validateZoomWebhook,
  handleZoomUrlValidation
};
