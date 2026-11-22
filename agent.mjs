import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GoogleGenAI, Type } from '@google/genai';
import { google } from 'googleapis';

const HISTORY_FILE = './history.json';
const CHANNEL_IDS = (process.env.SOURCE_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CAPTION_LANG = (process.env.CAPTION_LANGUAGE || 'en').trim().toLowerCase();
const CLIP_DURATION = Number(process.env.CLIP_DURATION_SEC || '45');
const VISIBILITY = process.env.UPLOAD_VISIBILITY || 'public';

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { uploadedClipKeys: [] };
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function cleanupTempFiles() {
  for (const file of fs.readdirSync('.')) {
    if (
      file.startsWith('source.') ||
      file === 'output_short.mp4' ||
      file === 'captions.srt' ||
      file === 'cookies.txt'
    ) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

async function fetchLatestVideosFromRss(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  if (!res.ok) throw new Error(`RSS fetch failed for ${channelId}: ${res.status}`);
  const xml = await res.text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
  return entries.slice(0, 8).map((entry) => {
    const videoId = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (entry.match(/<title>([^<]+)<\/title>/) || [])[1] || 'Latest Video';
    const description = (entry.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || '';
    return { videoId, title, description, url: `https://www.youtube.com/watch?v=${videoId}` };
  }).filter((v) => v.videoId);
}

function toSrtTime(sec) {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(msTotal / 3600000)).padStart(2, '0');
  const m = String(Math.floor((msTotal % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((msTotal % 60000) / 1000)).padStart(2, '0');
  const ms = String(msTotal % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
}

function cleanVttTranscript(raw) {
  const seen = new Set();
  const cleanLines = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();
    if (
      !trimmed ||
      trimmed === 'WEBVTT' ||
      /^Kind:|^Language:/i.test(trimmed) ||
      /^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(trimmed) ||
      /^\d+$/.test(trimmed)
    ) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      cleanLines.push(trimmed);
    }
  }
  return cleanLines.join(' ').slice(0, 3500);
}

async function detectViralClipWithGemini(video, subtitleText) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const models = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let lastErr = null;

  const languageRule =
    CAPTION_LANG === 'ur'
      ? 'Write shortTitle, shortDescription, and captions in crisp Urdu script.'
      : CAPTION_LANG === 'roman-ur'
        ? 'Write shortTitle, shortDescription, and captions in punchy Roman Urdu.'
        : 'Write shortTitle, shortDescription, hashtags, and EVERY caption line STRICTLY in punchy, viral English ONLY (3-5 words per caption line, natural YouTube Shorts style, ZERO Urdu or non-English characters).';

  const cleanTranscript = cleanVttTranscript(subtitleText);

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: `Analyze this YouTube video and pick ONE highest-retention ${CLIP_DURATION}-second vertical Short segment.
Title: ${video.title}
Description: ${video.description.slice(0, 400)}
Transcript excerpt: ${cleanTranscript}

STRICT OUTPUT LIMITS (keep JSON compact and valid):
- ${languageRule}
- shortTitle: max 70 characters.
- shortDescription: 1-2 short sentences (max 180 characters).
- hashtags: ONLY 4 to 5 short hashtags.
- captions: ONLY 8 to 14 caption objects total covering 0 to ${CLIP_DURATION} seconds (3-5 words per caption). Never repeat captions.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              startSec: { type: Type.NUMBER },
              endSec: { type: Type.NUMBER },
              shortTitle: { type: Type.STRING },
              shortDescription: { type: Type.STRING },
              hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
              captions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    startSec: { type: Type.NUMBER },
                    endSec: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });
      if (response.text) {
        const parsed = JSON.parse(response.text.trim());
        if (Array.isArray(parsed.captions)) {
          parsed.captions = parsed.captions.slice(0, 16);
        }
        return parsed;
      }
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr || new Error('Gemini analysis returned empty output.');
}

async function uploadShortToYouTube(videoPath, clipPlan) {
  const oauth2 = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const tags = (clipPlan.hashtags || []).map((t) => t.replace(/^#/, ''));
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: `${clipPlan.shortTitle} #Shorts`.slice(0, 99),
        description: `${clipPlan.shortDescription}\n\n${(clipPlan.hashtags || []).join(' ')} #Shorts`,
        tags,
        categoryId: '22',
      },
      status: {
        privacyStatus: VISIBILITY,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  console.log('Uploaded YouTube Short ID:', res.data.id);
  return res.data.id;
}

function prepareCookiesFile(rawCookies) {
  if (!rawCookies || !rawCookies.trim()) return false;
  const trimmed = rawCookies.trim();
  let format = 'netscape';
  let netscapeBody = '';

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [];
      const rows = list
        .filter((c) => c && c.domain && c.name && c.value !== undefined)
        .map((c) => {
          const domain = String(c.domain);
          const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
          const path = String(c.path || '/');
          const secure = c.secure ? 'TRUE' : 'FALSE';
          const expiry = c.expirationDate ? Math.floor(Number(c.expirationDate)) : 0;
          return `${domain}\t${includeSub}\t${path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`;
        });
      if (rows.length > 0) {
        format = 'converted-json';
        netscapeBody = '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n';
      }
    } catch {
      // Fall through to raw Netscape handling
    }
  }

  if (!netscapeBody) {
    const normalized = trimmed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const hasHeader = /^#\s*(Netscape|HTTP Cookie File)/i.test(normalized);
    netscapeBody = (hasHeader ? normalized : '# Netscape HTTP Cookie File\n' + normalized) + '\n';
  }

  const lines = netscapeBody.split('\n').filter((l) => l && !l.startsWith('#'));
  const ytLines = lines.filter((l) => /youtube\.com|google\.com/i.test(l.split('\t')[0] || '')).length;
  const hasAuth = lines.some((l) => /\t(LOGIN_INFO|__Secure-3PSID|__Secure-1PSID|SAPISID|SID)\t/.test(l));
  console.log(`Loaded YOUTUBE_COOKIES (${format}): ${ytLines} YouTube/Google entries, authCookiePresent=${hasAuth}`);
  fs.writeFileSync('cookies.txt', netscapeBody, 'utf8');
  return true;
}

function downloadVideoWithFallback(videoUrl, hasCookies) {
  const baseArgs = [
    '--js-runtimes', 'node',
    '--sleep-requests', '1',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--match-filter', '!is_live',
    '-o', 'source.%(ext)s',
  ];

  if (process.env.YTDLP_PROXY && process.env.YTDLP_PROXY.trim()) {
    baseArgs.push('--proxy', process.env.YTDLP_PROXY.trim());
  }

  const bgutilArgs = process.env.GITHUB_ACTIONS
    ? ['--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416']
    : [];

  const strategies = [];
  if (hasCookies) {
    strategies.push({
      label: 'cookies + mweb/tv/web_safari + bgutil PO token',
      extraArgs: ['--cookies', 'cookies.txt', ...bgutilArgs, '--extractor-args', 'youtube:player_client=mweb,tv,web_safari,web_creator'],
    });
    strategies.push({
      label: 'cookies + default client + bgutil PO token',
      extraArgs: ['--cookies', 'cookies.txt', ...bgutilArgs],
    });
  }
  strategies.push({
    label: 'cookieless + mweb/android_vr + bgutil PO token',
    extraArgs: [...bgutilArgs, '--extractor-args', 'youtube:player_client=mweb,android_vr'],
  });

  let lastError = null;
  let winningExtraArgs = null;
  for (const strategy of strategies) {
    console.log(`Trying yt-dlp strategy: ${strategy.label}`);
    try {
      execFileSync('yt-dlp', [...baseArgs, ...strategy.extraArgs, videoUrl], { stdio: 'inherit' });
      if (fs.existsSync('source.mp4')) {
        winningExtraArgs = strategy.extraArgs;
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Strategy failed (${strategy.label}), trying next fallback...`);
    }
  }

  if (!winningExtraArgs) {
    throw lastError || new Error('All yt-dlp download strategies failed.');
  }

  try {
    const subArgs = ['--js-runtimes', 'node', '--skip-download', '--write-auto-sub', '--sub-format', 'vtt', '-o', 'source.%(ext)s'];
    if (process.env.YTDLP_PROXY && process.env.YTDLP_PROXY.trim()) {
      subArgs.push('--proxy', process.env.YTDLP_PROXY.trim());
    }
    execFileSync('yt-dlp', [...subArgs, ...winningExtraArgs, videoUrl], { stdio: 'inherit' });
  } catch {
    console.warn('Auto-subtitles unavailable or rate-limited; falling back to video title & description for Gemini.');
  }
}

function getVideoDurationSec(filePath) {
  try {
    const raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { encoding: 'utf8' }
    ).trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function run() {
  if (!CHANNEL_IDS.length) throw new Error('Set SOURCE_CHANNEL_IDS environment variable.');
  if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY secret.');
  if (!process.env.YOUTUBE_REFRESH_TOKEN) throw new Error('Missing YOUTUBE_REFRESH_TOKEN secret.');

  const history = loadHistory();
  let chosenVideo = null;

  for (const cid of CHANNEL_IDS) {
    const videos = await fetchLatestVideosFromRss(cid);
    chosenVideo = videos.find((v) => !history.uploadedClipKeys.includes(v.videoId));
    if (chosenVideo) break;
  }

  if (!chosenVideo) {
    console.log('All recent videos from watched channels have already been clipped.');
    return;
  }

  cleanupTempFiles();
  try {
    console.log('Processing latest video:', chosenVideo.title);
    const hasCookies = prepareCookiesFile(process.env.YOUTUBE_COOKIES);
    downloadVideoWithFallback(chosenVideo.url, hasCookies);

    if (!fs.existsSync('source.mp4')) {
      throw new Error('Video download was skipped (possibly a live stream) or source.mp4 was not created.');
    }

    const vttFile = fs.readdirSync('.').find((f) => f.startsWith('source.') && f.endsWith('.vtt'));
    const subtitleText = vttFile ? fs.readFileSync(vttFile, 'utf8') : chosenVideo.description;

    const clipPlan = await detectViralClipWithGemini(chosenVideo, subtitleText);
    const totalDuration = getVideoDurationSec('source.mp4');
    let start = Math.max(0, Math.floor(clipPlan.startSec || 10));
    let duration = Math.min(58, Math.max(15, Math.floor((clipPlan.endSec || start + CLIP_DURATION) - start)));
    if (totalDuration > 0) {
      if (start >= totalDuration - 10) start = 0;
      duration = Math.min(duration, Math.max(5, Math.floor(totalDuration - start)));
    }

    const srtBody = (clipPlan.captions || [])
      .map((c, idx) => {
        const rawStart = Number(c.startSec || 0);
        const rawEnd = Number(c.endSec || rawStart + 3);
        const relStart = rawStart >= start && start > 0 ? rawStart - start : rawStart;
        const relEnd = rawEnd >= start && start > 0 ? rawEnd - start : rawEnd;
        const clampedStart = Math.max(0, Math.min(duration - 0.5, relStart));
        const clampedEnd = Math.max(clampedStart + 0.5, Math.min(duration, relEnd));
        return `${idx + 1}\n${toSrtTime(clampedStart)} --> ${toSrtTime(clampedEnd)}\n${c.text}`;
      })
      .join('\n\n');
    fs.writeFileSync('captions.srt', srtBody || `1\n00:00:00,000 --> 00:00:04,000\n${clipPlan.shortTitle}\n`);

    const subtitleStyle =
      CAPTION_LANG === 'ur'
        ? "FontName=Noto Sans Arabic,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Alignment=2,MarginV=75"
        : "FontName=Arial,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=95";

    execFileSync('ffmpeg', [
      '-y',
      '-ss', String(start),
      '-i', 'source.mp4',
      '-t', String(duration),
      '-vf', `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=captions.srt:force_style='${subtitleStyle}'`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      'output_short.mp4',
    ], { stdio: 'inherit' });

    await uploadShortToYouTube('output_short.mp4', clipPlan);
    history.uploadedClipKeys.push(chosenVideo.videoId);
    saveHistory(history);
  } finally {
    cleanupTempFiles();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
