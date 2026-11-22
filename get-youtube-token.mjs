/**
 * One-Time YouTube Account Login Helper
 * Run locally ONCE: npm run auth
 * Opens a Google Sign-In link for your YouTube channel and prints your YOUTUBE_REFRESH_TOKEN
 * to paste into GitHub Repository -> Settings -> Secrets -> Actions.
 */
import http from 'node:http';
import { google } from 'googleapis';

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4242/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first.');
  console.error('Example (Mac/Linux): YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... npm run auth');
  console.error('Example (Windows PowerShell): $env:YOUTUBE_CLIENT_ID="..."; $env:YOUTUBE_CLIENT_SECRET="..."; npm run auth');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

console.log('\n1. Open this link in your browser and sign in with your YouTube channel account:\n');
console.log(authUrl);
console.log('\n2. Waiting for Google sign-in callback on http://localhost:4242 ...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) return;
  const url = new URL(req.url, 'http://localhost:4242');
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('Authorization failed: no code received.');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    console.log('=== COPY THIS INTO GITHUB SECRET: YOUTUBE_REFRESH_TOKEN ===\n');
    console.log(tokens.refresh_token || 'No refresh token returned — revoke app access and retry.');
    console.log('\n===========================================================');
    res.end('Success! Return to your terminal and copy your YOUTUBE_REFRESH_TOKEN.');
  } catch (err) {
    console.error('Token exchange failed:', err);
    res.end('Token exchange failed. Check terminal output.');
  } finally {
    server.close();
  }
});

server.listen(4242);
