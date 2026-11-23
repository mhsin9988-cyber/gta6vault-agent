/**
 * ClipPulse 24/7 Autonomous YouTube Clip & Upload Agent
 * Last-24h GTA 6 USA Viral Hunter Edition:
 * 1. Scans YouTube's Last 24 Hours (sp=EgIIAg%3D%3D, gl=US) across GTA 6 Easter Eggs, Funny Moments, New Discoveries & Live Stream VODs (0 YouTube API quota).
 * 2. Verifies each creator's public YouTube /about country metadata and rejects non-USA creators when CREATOR_REGION=US.
 * 3. Uses Gemini AI to rank the Top 3 highest viral-potential candidates and auto-clips/uploads Top 1 (or Top 3) with punchy English Shorts captions.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GoogleGenAI, Type } from '@google/genai';
import { google } from 'googleapis';

const HISTORY_FILE = './history.json';
const CHANNEL_IDS = (process.env.SOURCE_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DISCOVERY_MODE = (process.env.DISCOVERY_MODE || 'usa_viral').trim().toLowerCase();
const CREATOR_REGION = (process.env.CREATOR_REGION || 'US').trim().toUpperCase();
const MAX_VIDEO_AGE_HOURS = Number(process.env.MAX_VIDEO_AGE_HOURS || '24');
const MAX_CLIPS_PER_RUN = Math.max(1, Math.min(3, Number(process.env.MAX_CLIPS_PER_RUN || '1')));
const INCLUDE_LIVE_VODS = (process.env.INCLUDE_LIVE_VODS || 'true').trim().toLowerCase() !== 'false';
const PRIORITIZE_CLIP_ALLOWED = (process.env.PRIORITIZE_CLIP_ALLOWED || 'true').trim().toLowerCase() !== 'false';
const PRIORITIZE_BIG_CREATORS = (process.env.PRIORITIZE_BIG_CREATORS || 'true').trim().toLowerCase() !== 'false';
const MIN_CREATOR_SUBSCRIBERS = Number(process.env.MIN_CREATOR_SUBSCRIBERS || '50000');
const USA_VIRAL_TOPICS = (
  process.env.USA_VIRAL_TOPICS ||
  'GTA 6 easter egg secret found,GTA 6 funny moments gameplay clips,GTA 6 new discovery hidden detail update,GTA 6 live stream highlights reaction'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CAPTION_LANG = (process.env.CAPTION_LANGUAGE || 'en').trim().toLowerCase();
const CLIP_DURATION = Number(process.env.CLIP_DURATION_SEC || '45');
const VISIBILITY = process.env.UPLOAD_VISIBILITY || 'public';

const channelProfileCache = new Map();
const clipPermissionCache = new Map();

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { uploadedClipKeys: [] };
  const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  return { uploadedClipKeys: Array.isArray(parsed.uploadedClipKeys) ? parsed.uploadedClipKeys : [] };
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
    return {
      videoId,
      title,
      description,
      channel: channelId,
      creatorCountry: 'Source Channel',
      isUsaVerified: true,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }).filter((v) => v.videoId);
}

function parseCompactNumber(raw) {
  const text = String(raw || '').replace(/,/g, '').trim();
  const m = text.match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return 0;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'B') return Math.round(num * 1_000_000_000);
  if (suffix === 'M') return Math.round(num * 1_000_000);
  if (suffix === 'K') return Math.round(num * 1_000);
  return Math.round(num);
}

const CLIP_PERMISSION_REGEX = /\b(feel free to clip|clips? allowed|clipping allowed|free to clip|permission to clip|reuse allowed|creative commons|make clips|clip this stream|clip my stream)\b/i;

async function fetchChannelProfile(channelId, channelUrl) {
  const cacheKey = channelId || channelUrl || '';
  const defaultProfile = {
    country: 'Unlisted',
    status: 'UNKNOWN',
    subscriberCount: 0,
    subscriberLabel: 'Unknown',
    aboutClipFriendly: false,
  };
  if (!cacheKey) return defaultProfile;
  if (channelProfileCache.has(cacheKey)) return channelProfileCache.get(cacheKey);

  const aboutUrl = channelId
    ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/about?hl=en&gl=US`
    : `${String(channelUrl).replace(/\/$/, '')}/about?hl=en&gl=US`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(aboutUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      channelProfileCache.set(cacheKey, defaultProfile);
      return defaultProfile;
    }
    const html = await res.text();
    const countryMatch =
      html.match(/"country"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/) ||
      html.match(/"aboutChannelViewModel"[\s\S]{0,2500}?"country"\s*:\s*"([^"]+)"/);

    const subMatch =
      html.match(/"subscriberCountText"\s*:\s*"([^"]*subscribers?)"/i) ||
      html.match(/"subscriberCountText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/i) ||
      html.match(/(\d+(?:\.\d+)?[KMB]?)\s+subscribers/i);

    const country = countryMatch && countryMatch[1] ? countryMatch[1].trim() : 'Unlisted';
    const isUs = /^(united states|united states of america|usa|us)$/i.test(country);
    const status = country === 'Unlisted' ? 'UNKNOWN' : isUs ? 'US' : 'NON_US';
    const subscriberLabel = subMatch && subMatch[1] ? subMatch[1].replace(/\s*subscribers?/i, '').trim() : 'Unknown';
    const subscriberCount = parseCompactNumber(subscriberLabel);
    const aboutClipFriendly = CLIP_PERMISSION_REGEX.test(html.slice(0, 250000));

    const result = { country, status, subscriberCount, subscriberLabel, aboutClipFriendly };
    channelProfileCache.set(cacheKey, result);
    return result;
  } catch {
    channelProfileCache.set(cacheKey, defaultProfile);
    return defaultProfile;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectVideoClipPermission(videoId) {
  const defaultPerm = {
    youtubeClipsEnabled: false,
    isCreativeCommons: false,
    explicitClipPermission: false,
  };
  if (!videoId) return defaultPerm;
  if (clipPermissionCache.has(videoId)) return clipPermissionCache.get(videoId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&gl=US`, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      clipPermissionCache.set(videoId, defaultPerm);
      return defaultPerm;
    }
    const html = await res.text();
    const youtubeClipsEnabled =
      /"clipConfig"\s*:\s*\{/.test(html) ||
      /"clipCreationRenderer"/.test(html) ||
      /"iconType"\s*:\s*"CONTENT_CUT"/.test(html);
    const isCreativeCommons =
      /Creative Commons Attribution license \(reuse allowed\)/i.test(html) ||
      /creativecommons\.org\/licenses\/by/i.test(html);
    const descMatch = html.match(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const shortDesc = descMatch ? descMatch[1] : '';
    const explicitClipPermission = CLIP_PERMISSION_REGEX.test(shortDesc);

    const result = { youtubeClipsEnabled, isCreativeCommons, explicitClipPermission };
    clipPermissionCache.set(videoId, result);
    return result;
  } catch {
    clipPermissionCache.set(videoId, defaultPerm);
    return defaultPerm;
  } finally {
    clearTimeout(timer);
  }
}

function computeCandidatePriorityScore(cand) {
  let score = 0;
  // 1. Creator size priority (Big Creators get highest boost)
  if (PRIORITIZE_BIG_CREATORS) {
    const subs = Number(cand.subscriberCount || 0);
    if (subs >= 1_000_000) score += 40;
    else if (subs >= 250_000) score += 30;
    else if (subs >= 100_000) score += 22;
    else if (subs >= MIN_CREATOR_SUBSCRIBERS) score += 12;
  }
  // 2. Clip-Allowed / Streamer Clip-Friendly priority
  if (PRIORITIZE_CLIP_ALLOWED) {
    if (cand.isCreativeCommons || cand.explicitClipPermission || cand.aboutClipFriendly) score += 35;
    if (cand.youtubeClipsEnabled) score += 25;
  }
  // 3. Verified USA Creator + Completed Stream VOD bonus
  if (cand.isUsaVerified) score += 20;
  if (cand.wasLive && (cand.youtubeClipsEnabled || cand.explicitClipPermission || cand.aboutClipFriendly)) {
    score += 15;
  }
  // 4. 24h View velocity score (0-25 pts)
  score += Math.min(25, Math.round(Math.log10(Math.max(10, Number(cand.viewCount || 0))) * 4));
  return score;
}

function hasMostlyLatinText(text) {
  const cleaned = String(text || '').replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!cleaned) return true;
  const latinChars = (cleaned.match(/[A-Za-z]/g) || []).length;
  return latinChars / cleaned.length >= 0.65;
}

function searchYouTubeByTimeWindow(topic, spFilter) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(topic)}&sp=${spFilter}&gl=US&hl=en`;
  const searchArgs = [
    '--flat-playlist',
    '--playlist-end', '12',
    '--dump-json',
    '--force-ipv4',
    '--no-warnings',
    '--extractor-args', 'youtube:lang=en',
    searchUrl,
  ];
  if (process.env.YTDLP_PROXY && process.env.YTDLP_PROXY.trim()) {
    searchArgs.unshift('--proxy', process.env.YTDLP_PROXY.trim());
  }
  const stdout = execFileSync('yt-dlp', searchArgs, { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function discoverLast24hGta6UsaCandidates(history) {
  if (!USA_VIRAL_TOPICS.length) return [];

  // YouTube search protobuf filters:
  // EgIIAg%3D%3D = Upload date: Today (Last 24 hours)
  // EgIIAw%3D%3D = Upload date: This week (fallback if last 24h has 0 fresh hits)
  const primaryFilter = MAX_VIDEO_AGE_HOURS <= 24 ? 'EgIIAg%3D%3D' : 'EgIIAw%3D%3D';
  const filtersToTry = primaryFilter === 'EgIIAg%3D%3D' ? ['EgIIAg%3D%3D', 'EgIIAw%3D%3D'] : ['EgIIAw%3D%3D'];

  for (const spFilter of filtersToTry) {
    const windowLabel = spFilter === 'EgIIAg%3D%3D' ? 'Last 24 Hours' : 'This Week (fallback)';
    console.log(`Scanning YouTube [${windowLabel}] across ${USA_VIRAL_TOPICS.length} GTA 6 USA viral topics...`);
    const dedupMap = new Map();

    for (const topic of USA_VIRAL_TOPICS) {
      console.log(`  -> Searching "${topic}" (${windowLabel}, gl=US)...`);
      try {
        const rawItems = searchYouTubeByTimeWindow(topic, spFilter);
        for (const item of rawItems) {
          if (!item || !item.id || dedupMap.has(item.id)) continue;
          if (history.uploadedClipKeys.includes(item.id)) continue;
          if (item.live_status === 'is_live' || item.live_status === 'is_upcoming') continue;
          if (!INCLUDE_LIVE_VODS && item.live_status === 'was_live') continue;
          if (!hasMostlyLatinText(item.title)) continue;

          const dur = Number(item.duration || 0);
          if (dur < 75 || dur > 5400) continue;

          dedupMap.set(item.id, {
            videoId: item.id,
            title: item.title || 'GTA 6 Viral Highlight',
            description: item.description || item.title || topic,
            channel: item.channel || item.uploader || 'Unknown Creator',
            channelId: item.channel_id || '',
            channelUrl: item.channel_url || item.uploader_url || '',
            viewCount: Number(item.view_count || 0),
            durationSec: dur,
            wasLive: item.live_status === 'was_live',
            matchedTopic: topic,
            url: `https://www.youtube.com/watch?v=${item.id}`,
          });
        }
      } catch (err) {
        console.warn(`Search failed for "${topic}":`, err.message || err);
      }
    }

    const sortedRaw = Array.from(dedupMap.values()).sort((a, b) => b.viewCount - a.viewCount);
    console.log(`Found ${sortedRaw.length} fresh unclipped candidates in ${windowLabel}. Checking USA creator profiles, subscriber counts & clip permissions...`);

    const usaVerified = [];
    const unlistedEnglish = [];

    for (const cand of sortedRaw.slice(0, 16)) {
      const profile = await fetchChannelProfile(cand.channelId, cand.channelUrl);
      cand.creatorCountry = profile.country;
      cand.isUsaVerified = profile.status === 'US';
      cand.subscriberCount = profile.subscriberCount;
      cand.subscriberLabel = profile.subscriberLabel;
      cand.aboutClipFriendly = profile.aboutClipFriendly;

      if (CREATOR_REGION === 'US' && profile.status === 'NON_US') {
        console.log(`  [SKIP non-US] "${cand.title.slice(0, 50)}" by ${cand.channel} (${profile.country})`);
        continue;
      }

      if (PRIORITIZE_CLIP_ALLOWED) {
        const perm = await inspectVideoClipPermission(cand.videoId);
        cand.youtubeClipsEnabled = perm.youtubeClipsEnabled;
        cand.isCreativeCommons = perm.isCreativeCommons;
        cand.explicitClipPermission = perm.explicitClipPermission;
      } else {
        cand.youtubeClipsEnabled = false;
        cand.isCreativeCommons = false;
        cand.explicitClipPermission = false;
      }

      cand.priorityScore = computeCandidatePriorityScore(cand);
      const clipTag =
        cand.isCreativeCommons || cand.explicitClipPermission || cand.aboutClipFriendly
          ? 'CLIP-PERMITTED'
          : cand.youtubeClipsEnabled
            ? 'YT-CLIPS-ON'
            : 'standard';

      if (CREATOR_REGION !== 'US' || profile.status === 'US') {
        console.log(
          `  [USA | ${cand.subscriberLabel} subs | ${clipTag} | prio=${cand.priorityScore}] "${cand.title.slice(0, 52)}" by ${cand.channel} (views=${cand.viewCount})`
        );
        usaVerified.push(cand);
      } else {
        unlistedEnglish.push(cand);
      }
    }

    usaVerified.sort((a, b) => b.priorityScore - a.priorityScore);
    unlistedEnglish.sort((a, b) => b.priorityScore - a.priorityScore);

    const shortlisted =
      usaVerified.length >= 5
        ? usaVerified.slice(0, 12)
        : [...usaVerified, ...unlistedEnglish].slice(0, 12);

    if (shortlisted.length > 0) {
      return shortlisted;
    }
  }

  return [];
}

async function rankTop3ViralWithGemini(candidates) {
  if (candidates.length <= 1) return candidates;

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const models = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  const summaryRows = candidates.map((c, idx) => ({
    idx: idx + 1,
    videoId: c.videoId,
    title: c.title,
    channel: c.channel,
    creatorCountry: c.creatorCountry,
    isUsaVerified: c.isUsaVerified,
    subscriberCount: c.subscriberCount || 0,
    subscriberLabel: c.subscriberLabel || 'Unknown',
    youtubeClipsEnabled: Boolean(c.youtubeClipsEnabled),
    isCreativeCommons: Boolean(c.isCreativeCommons),
    explicitClipPermission: Boolean(c.explicitClipPermission || c.aboutClipFriendly),
    priorityScore: c.priorityScore || 0,
    viewCount: c.viewCount,
    durationSec: c.durationSec,
    isLiveStreamVod: c.wasLive,
    topic: c.matchedTopic,
  }));

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: `You are a viral YouTube Shorts strategist specializing in GTA 6 (Grand Theft Auto VI) USA gaming content.
Review these fresh videos uploaded in the last ${MAX_VIDEO_AGE_HOURS} hours and select the TOP 3 videos with the HIGHEST viral Shorts potential.

CRITERIA (strict priority order):
1. HIGHEST PRIORITY: Big USA creators (high subscriberCount: 100K+, 500K+, 1M+) whose video or completed live stream has clipping allowed (youtubeClipsEnabled=true, isCreativeCommons=true, or explicitClipPermission=true).
2. Content must be about GTA 6 Easter eggs, hilarious/funny moments, brand-new discoveries/secrets, or hype live stream highlights.
3. Strongly prioritize verified United States (USA) creators (isUsaVerified=true) and high priorityScore; reject non-US or clickbait spam.
4. Combine big-creator authority + clip-allowed status + viral payoff into viralScore (1-100).

CANDIDATES:
${JSON.stringify(summaryRows, null, 2)}

Return ONLY the Top 3 ranked picks ordered from #1 (highest viral & creator priority) to #3.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              top3: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    videoId: { type: Type.STRING },
                    viralScore: { type: Type.NUMBER },
                    category: { type: Type.STRING },
                    reason: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text.trim());
        const picks = Array.isArray(parsed.top3) ? parsed.top3 : [];
        const byId = new Map(candidates.map((c) => [c.videoId, c]));
        const ranked = [];
        for (const pick of picks) {
          const matched = byId.get(pick.videoId);
          if (matched && !ranked.some((r) => r.videoId === matched.videoId)) {
            ranked.push({
              ...matched,
              viralScore: Number(pick.viralScore || 85),
              viralCategory: pick.category || 'GTA 6 Viral',
              viralReason: pick.reason || 'High Shorts viral potential',
            });
          }
        }
        if (ranked.length > 0) {
          console.log('\n=== TOP 3 VIRAL GTA 6 (USA / BIG CREATOR / CLIP-PRIORITY) PICKS ===');
          ranked.slice(0, 3).forEach((item, i) => {
            const clipFlag = item.isCreativeCommons || item.explicitClipPermission || item.aboutClipFriendly
              ? 'Clip Permitted'
              : item.youtubeClipsEnabled
                ? 'YT Clips Enabled'
                : 'Standard';
            console.log(
              `#${i + 1} [Score ${item.viralScore}/100] [${item.viralCategory}] [${item.subscriberLabel} subs | ${clipFlag}] "${item.title}" by ${item.channel} (${item.creatorCountry}, views=${item.viewCount}) — ${item.viralReason}`
            );
          });
          console.log('==================================================================\n');
          return ranked.slice(0, 3);
        }
      }
    } catch (err) {
      console.warn(`Gemini Top-3 ranking attempt (${model}) failed:`, err.message || err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return candidates.slice(0, 3);
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
        contents: `Analyze this GTA 6 / USA gaming YouTube video and pick ONE highest-retention ${CLIP_DURATION}-second vertical Short segment (focus on the exact Easter egg reveal, funniest moment, or biggest discovery).
Title: ${video.title}
Creator: ${video.channel || 'USA Creator'}
Description: ${String(video.description || '').slice(0, 400)}
Transcript excerpt: ${cleanTranscript}

STRICT OUTPUT LIMITS (keep JSON compact and valid):
- ${languageRule}
- shortTitle: max 70 characters, high-CTR GTA 6 Shorts hook.
- shortDescription: 1-2 short sentences (max 180 characters).
- hashtags: ONLY 4 to 5 short hashtags (include #GTA6 #Gaming).
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
        categoryId: '20',
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

function downloadVideoWithFallback(videoUrl, hasCookies, durationSec = 0) {
  // Use 720p cap for longer stream VODs (>20 min) so downloads stay fast and crisp for 9:16 Shorts
  const formatSelector =
    durationSec > 1200
      ? 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b'
      : 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b';

  const baseArgs = [
    '--js-runtimes', 'node',
    '--sleep-requests', '1',
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '--match-filter', '!is_live',
    '-o', 'source.%(ext)s',
  ];

  if (process.env.YTDLP_PROXY && process.env.YTDLP_PROXY.trim()) {
    baseArgs.push('--proxy', process.env.YTDLP_PROXY.trim());
    console.log('Using configured YTDLP_PROXY for yt-dlp requests.');
  }

  const bgutilArgs =
    process.env.GITHUB_ACTIONS && process.platform === 'linux'
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
    label: 'default yt-dlp client (best for home/residential IP)',
    extraArgs: ['--force-ipv4'],
  });
  strategies.push({
    label: 'cookieless + tv/web_safari/android_vr fallback',
    extraArgs: ['--force-ipv4', ...bgutilArgs, '--extractor-args', 'youtube:player_client=tv,web_safari,android_vr'],
  });
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

async function processAndUploadVideo(chosenVideo, history) {
  cleanupTempFiles();
  try {
    console.log(`\nProcessing GTA 6 viral pick: "${chosenVideo.title}" (${chosenVideo.url})`);
    const hasCookies = prepareCookiesFile(process.env.YOUTUBE_COOKIES);
    downloadVideoWithFallback(chosenVideo.url, hasCookies, chosenVideo.durationSec || 0);

    if (!fs.existsSync('source.mp4')) {
      throw new Error('Video download was skipped (possibly an active live stream) or source.mp4 was not created.');
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

async function run() {
  if (!CHANNEL_IDS.length && DISCOVERY_MODE === 'channels_only') {
    throw new Error('Set SOURCE_CHANNEL_IDS or use DISCOVERY_MODE=usa_viral.');
  }
  if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY secret.');
  if (!process.env.YOUTUBE_REFRESH_TOKEN) throw new Error('Missing YOUTUBE_REFRESH_TOKEN secret.');

  const history = loadHistory();
  let selectedVideos = [];

  if (DISCOVERY_MODE !== 'channels_only') {
    const freshCandidates = await discoverLast24hGta6UsaCandidates(history);
    if (freshCandidates.length > 0) {
      const top3 = await rankTop3ViralWithGemini(freshCandidates);
      selectedVideos = top3.slice(0, MAX_CLIPS_PER_RUN);
    }
  }

  if (selectedVideos.length === 0 && DISCOVERY_MODE !== 'usa_viral') {
    for (const cid of CHANNEL_IDS) {
      const videos = await fetchLatestVideosFromRss(cid);
      const nextUnclipped = videos.find((v) => !history.uploadedClipKeys.includes(v.videoId));
      if (nextUnclipped) {
        selectedVideos.push(nextUnclipped);
        if (selectedVideos.length >= MAX_CLIPS_PER_RUN) break;
      }
    }
  }

  if (selectedVideos.length === 0) {
    console.log('No new unclipped USA GTA 6 videos found in this window.');
    return;
  }

  let uploadedCount = 0;

  for (const video of selectedVideos) {
    try {
      await processAndUploadVideo(video, history);
      uploadedCount += 1;
    } catch (err) {
      console.error(`Failed processing "${video.title}":`, err.message || err);
      if (selectedVideos.length === 1) throw err;
    }
  }

  if (uploadedCount === 0) {
    throw new Error('All selected viral candidates failed to process/upload.');
  }
  console.log(`Completed run cleanly: uploaded ${uploadedCount} Short(s).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
