# ClipPulse 24/7 Free YouTube Clipping Agent

## Why This Runs 24/7 for FREE (Even When Your PC is OFF)
1. **Zero Gmail Quota Used**: Channel monitoring uses YouTube's public Atom RSS feed (`0` API units). Uploading uses YouTube Data API v3's dedicated free daily quota (**10,000 units/day** — enough for up to 6 Shorts/day completely free).
2. **Runs While Your System is Off**: GitHub Actions runs this workflow automatically on cloud servers at your exact scheduled times:
   - **16:00** (America/New_York (EST, UTC-5)) -> Cron `0 21 * * *` UTC
   - **17:00** (America/New_York (EST, UTC-5)) -> Cron `0 22 * * *` UTC
   - **18:00** (America/New_York (EST, UTC-5)) -> Cron `0 23 * * *` UTC

## Quick 4-Step Setup
1. Create a free GitHub repository and upload all files from this ZIP bundle.
2. In Google Cloud Console, enable **YouTube Data API v3** (free tier, no billing required) and create an OAuth 2.0 Client ID (Desktop/Web with redirect URI `http://localhost:4242/oauth2callback`).
3. Run `npm install && YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... npm run auth` once on your computer to sign in to your YouTube channel (@GTA6Vault3) and copy your `YOUTUBE_REFRESH_TOKEN`.
4. Add all 4 secrets in GitHub (**Settings → Secrets and variables → Actions**):
   - `GEMINI_API_KEY`
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `YOUTUBE_REFRESH_TOKEN`
5. Open the **Actions** tab and click **Run workflow** once to test! From then on, it runs automatically 3x every day.
