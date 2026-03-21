// netlify/functions/oauth-callback.js
// Handles Google OAuth2 redirect, exchanges code for tokens
// Stores refresh token in Netlify environment (via a one-time setup flow)

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'https://tranquil-sherbet-fa414a.netlify.app/.netlify/functions/oauth-callback';

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return html(`<h2>OAuth Error</h2><p>${error}</p>`);
  }

  // Step 1: Show auth URL if no code yet
  if (!code) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.readonly');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return {
      statusCode: 302,
      headers: { Location: url.toString() }
    };
  }

  // Step 2: Exchange code for tokens
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await resp.json();

    if (tokens.error) {
      return html(`<h2>Token Error</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>`);
    }

    // Show the refresh token so the admin can save it as env var GOOGLE_REFRESH_TOKEN
    return html(`
      <h2 style="color:#4ade80">✓ Authorization successful!</h2>
      <p>Copy the refresh token below and add it to your Netlify environment variables as <code>GOOGLE_REFRESH_TOKEN</code>:</p>
      <textarea rows="4" style="width:100%;font-family:monospace;padding:8px;background:#1a1a2e;color:#e0e0f0;border:1px solid #e94560">${tokens.refresh_token}</textarea>
      <p style="margin-top:12px">Go to: <strong>Netlify → Site configuration → Environment variables → Add variable</strong></p>
      <p>Key: <code>GOOGLE_REFRESH_TOKEN</code> — Value: the token above</p>
      <p>Then redeploy your site and you're done!</p>
    `);
  } catch (e) {
    return html(`<h2>Error</h2><pre>${e.message}</pre>`);
  }
};

function html(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><head><style>
      body{font-family:'Courier New',monospace;background:#07071a;color:#e0e0f0;padding:40px;max-width:700px;margin:auto}
      code{background:#1a1a2e;padding:2px 6px;border-radius:3px;color:#e94560}
      h2{color:#e94560}
    </style></head><body>${body}</body></html>`
  };
}
