/**
 * ClipPulse 24/7 Autonomous Cloud YouTube Clip & Upload Agent
 * Global USA/UK GTA 6 Viral & Copyright-Safe Edition (PC-OFF Ready):
 * 1. Scans YouTube across GTA 6 Easter Eggs, Leaks, Game Comparisons, New Discoveries & Trending Hooks (Last 24h -> This Week -> Creative Commons reuse-allowed, 0 API quota).
 * 2. Enforces Copyright-Safe / Clip-Allowed checks (YouTube Clips enabled, Creative Commons, or explicit creator clip permission; rejects corporate/restricted channels).
 * 3. Uses Gemini AI to rank Top viral hooks, clips & renders transformative 9:16 vertical Shorts with top viral hook banner + safe-zone captions + loudnorm audio.
 * 4. Automatically falls back across the ranked candidate pool if any single video fails cloud download, ensuring reliable 3x/day uploads.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GoogleGenAI, Type } from '@google/genai';
import { google } from 'googleapis';

const HISTORY_FILE = './history.json';
const CHANNEL_IDS = (process.env.SOURCE_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DISCOVERY_MODE = (process.env.DISCOVERY_MODE || 'hybrid').trim().toLowerCase();
const CREATOR_REGION = (process.env.CREATOR_REGION || 'US_UK_GLOBAL').trim().toUpperCase();
const MAX_VIDEO_AGE_HOURS = Number(process.env.MAX_VIDEO_AGE_HOURS || '48');
const MAX_CLIPS_PER_RUN = Math.max(1, Math.min(3, Number(process.env.MAX_CLIPS_PER_RUN || '1')));
const INCLUDE_LIVE_VODS = (process.env.INCLUDE_LIVE_VODS || 'true').trim().toLowerCase() !== 'false';
const PRIORITIZE_CLIP_ALLOWED = (process.env.PRIORITIZE_CLIP_ALLOWED || 'true').trim().toLowerCase() !== 'false';
const REQUIRE_CLIP_ALLOWED = (process.env.REQUIRE_CLIP_ALLOWED || 'true').trim().toLowerCase() !== 'false';
const PRIORITIZE_BIG_CREATORS = (process.env.PRIORITIZE_BIG_CREATORS || 'true').trim().toLowerCase() !== 'false';
const MIN_CREATOR_SUBSCRIBERS = Number(process.env.MIN_CREATOR_SUBSCRIBERS || '25000');
const USA_VIRAL_TOPICS = (
  process.env.USA_VIRAL_TOPICS ||
  'GTA 6 easter egg hidden secret details,GTA 6 leaks new discovery breakdown,GTA 6 vs GTA 5 RDR2 comparison graphics physics,GTA 6 crazy moments viral trending clips,GTA 6 map details trailer breakdown new update'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CAPTION_LANG = (process.env.CAPTION_LANGUAGE || 'en').trim().toLowerCase();
const CLIP_DURATION = Number(process.env.CLIP_DURATION_SEC || '42');
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
      file === 'captions.ass' ||
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

const CLIP_PERMISSION_REGEX = /\b(feel free to clip|clips? allowed|clipping allowed|free to clip|permission to clip|reuse allowed|creative commons|make clips|clip this stream|clip my stream|no copyright|free to use|reaction friendly)\b/i;
const COPYRIGHT_RESTRICTED_REGEX = /\b(do not reupload|no reuploads?|strictly prohibited|no permission to clip|copyright strike|do not clip|unauthorized use is prohibited)\b/i;
const CORPORATE_RISK_CHANNELS = /^(rockstar games|ign|gamespot|playstation|xbox|nintendo|take-two interactive|netflix|espn|vevo)$/i;

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
    const isUk = /^(united kingdom|uk|great britain|england)$/i.test(country);
    const status = country === 'Unlisted' ? 'UNKNOWN' : isUs ? 'US' : isUk ? 'UK' : 'OTHER';
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

async function inspectVideoClipPermission(videoId, channelName = '') {
  const defaultPerm = {
    youtubeClipsEnabled: false,
    isCreativeCommons: false,
    explicitClipPermission: false,
    copyrightRestricted: CORPORATE_RISK_CHANNELS.test(String(channelName || '').trim()),
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
    const copyrightRestricted =
      CORPORATE_RISK_CHANNELS.test(String(channelName || '').trim()) ||
      COPYRIGHT_RESTRICTED_REGEX.test(shortDesc);

    const result = { youtubeClipsEnabled, isCreativeCommons, explicitClipPermission, copyrightRestricted };
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
  // 1. Copyright-Safe / Clip-Allowed priority (Highest weight for monetization safety)
  if (PRIORITIZE_CLIP_ALLOWED) {
    if (cand.isCreativeCommons) score += 45;
    if (cand.explicitClipPermission || cand.aboutClipFriendly) score += 35;
    if (cand.youtubeClipsEnabled) score += 25;
  }
  // 2. Creator size authority (Big Creators get strong boost)
  if (PRIORITIZE_BIG_CREATORS) {
    const subs = Number(cand.subscriberCount || 0);
    if (subs >= 1_000_000) score += 35;
    else if (subs >= 250_000) score += 26;
    else if (subs >= 100_000) score += 20;
    else if (subs >= MIN_CREATOR_SUBSCRIBERS) score += 12;
  }
  // 3. USA / UK Creator boost + Viral angle keywords (Easter Eggs, Leaks, Comparisons)
  if (cand.isUsaVerified || cand.isUkVerified) score += 20;
  if (/easter egg|leak|vs|comparison|secret|hidden|new detail|breakdown|crazy|insane/i.test(cand.title || '')) {
    score += 18;
  }
  if (cand.wasLive && (cand.youtubeClipsEnabled || cand.explicitClipPermission || cand.aboutClipFriendly)) {
    score += 10;
  }
  // 4. View velocity score (0-30 pts)
  score += Math.min(30, Math.round(Math.log10(Math.max(10, Number(cand.viewCount || 0))) * 5));
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
  try {
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
  } catch (err) {
    // If proxy caused search error, retry directly without proxy
    if (process.env.YTDLP_PROXY && process.env.YTDLP_PROXY.trim()) {
      const directArgs = searchArgs.slice(2);
      const stdout = execFileSync('yt-dlp', directArgs, { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
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
    throw err;
  }
}

async function discoverLast24hGta6UsaCandidates(history) {
  if (!USA_VIRAL_TOPICS.length) return [];

  // YouTube search protobuf filters:
  // EgIIAg%3D%3D = Upload date: Today (Last 24 hours)
  // EgIIAw%3D%3D = Upload date: This week (7 days)
  // EgIwAQ%3D%3D = Creative Commons (Reuse Allowed — Copyright Free)
  const searchPasses = [
    ...(MAX_VIDEO_AGE_HOURS <= 24 ? [{ sp: 'EgIIAg%3D%3D', label: 'Last 24 Hours' }] : []),
    { sp: 'EgIIAw%3D%3D', label: 'This Week (Viral)' },
    { sp: 'EgIwAQ%3D%3D', label: 'Creative Commons (Copyright-Free)' },
  ];

  const dedupMap = new Map();

  for (const pass of searchPasses) {
    console.log(`Scanning YouTube [${pass.label}] across ${USA_VIRAL_TOPICS.length} GTA 6 viral topics...`);
    const topicsForPass = pass.sp === 'EgIwAQ%3D%3D' ? USA_VIRAL_TOPICS.slice(0, 3) : USA_VIRAL_TOPICS;

    for (const topic of topicsForPass) {
      console.log(`  -> Searching "${topic}" (${pass.label})...`);
      try {
        const rawItems = searchYouTubeByTimeWindow(topic, pass.sp);
        for (const item of rawItems) {
          if (!item || !item.id || dedupMap.has(item.id)) continue;
          if (history.uploadedClipKeys.includes(item.id)) continue;
          if (item.live_status === 'is_live' || item.live_status === 'is_upcoming') continue;
          if (!INCLUDE_LIVE_VODS && item.live_status === 'was_live') continue;
          if (!hasMostlyLatinText(item.title)) continue;

          const dur = Number(item.duration || 0);
          if (dur < 65 || dur > 5400) continue;

          dedupMap.set(item.id, {
            videoId: item.id,
            title: item.title || 'GTA 6 Viral Highlight',
            description: item.description || item.title || topic,
            channel: item.channel || item.uploader || 'Creator',
            channelId: item.channel_id || '',
            channelUrl: item.channel_url || item.uploader_url || '',
            viewCount: Number(item.view_count || 0),
            durationSec: dur,
            wasLive: item.live_status === 'was_live',
            fromCreativeCommonsPass: pass.sp === 'EgIwAQ%3D%3D',
            matchedTopic: topic,
            url: `https://www.youtube.com/watch?v=${item.id}`,
          });
        }
      } catch (err) {
        console.warn(`Search failed for "${topic}" (${pass.label}):`, err.message || err);
      }
    }

    if (dedupMap.size >= 18 && pass.sp !== 'EgIwAQ%3D%3D') {
      // Still allow Creative Commons pass to run if strict clip-allowed is enabled
      if (!REQUIRE_CLIP_ALLOWED) break;
    }
  }

  const sortedRaw = Array.from(dedupMap.values()).sort((a, b) => {
    if (a.fromCreativeCommonsPass !== b.fromCreativeCommonsPass) {
      return a.fromCreativeCommonsPass ? -1 : 1;
    }
    return b.viewCount - a.viewCount;
  });

  console.log(`Found ${sortedRaw.length} fresh unclipped GTA 6 candidates. Checking copyright safety, clip permissions & creator authority...`);

  const verifiedPool = [];
  const fallbackPool = [];

  for (const cand of sortedRaw.slice(0, 24)) {
    const profile = await fetchChannelProfile(cand.channelId, cand.channelUrl);
    cand.creatorCountry = profile.country;
    cand.isUsaVerified = profile.status === 'US';
    cand.isUkVerified = profile.status === 'UK';
    cand.subscriberCount = profile.subscriberCount;
    cand.subscriberLabel = profile.subscriberLabel;
    cand.aboutClipFriendly = profile.aboutClipFriendly;

    if (CREATOR_REGION === 'US' && profile.status !== 'US' && profile.status !== 'UNKNOWN') {
      console.log(`  [SKIP non-US] "${cand.title.slice(0, 50)}" by ${cand.channel} (${profile.country})`);
      continue;
    }

    const perm = await inspectVideoClipPermission(cand.videoId, cand.channel);
    cand.youtubeClipsEnabled = perm.youtubeClipsEnabled;
    cand.isCreativeCommons = perm.isCreativeCommons || cand.fromCreativeCommonsPass;
    cand.explicitClipPermission = perm.explicitClipPermission;
    cand.copyrightRestricted = perm.copyrightRestricted;

    if (cand.copyrightRestricted) {
      console.log(`  [SKIP copyright-risk] "${cand.title.slice(0, 50)}" by ${cand.channel}`);
      continue;
    }

    const isClipSafe =
      cand.isCreativeCommons ||
      cand.explicitClipPermission ||
      cand.aboutClipFriendly ||
      cand.youtubeClipsEnabled;

    if (REQUIRE_CLIP_ALLOWED && !isClipSafe) {
      console.log(`  [SKIP clips-disabled] "${cand.title.slice(0, 50)}" by ${cand.channel}`);
      continue;
    }

    cand.priorityScore = computeCandidatePriorityScore(cand);
    const clipTag = cand.isCreativeCommons
      ? 'CREATIVE-COMMONS'
      : cand.explicitClipPermission || cand.aboutClipFriendly
        ? 'CLIP-PERMITTED'
        : cand.youtubeClipsEnabled
          ? 'YT-CLIPS-ON'
          : 'standard';

    console.log(
      `  [${cand.creatorCountry} | ${cand.subscriberLabel} subs | ${clipTag} | prio=${cand.priorityScore}] "${cand.title.slice(0, 52)}" by ${cand.channel} (views=${cand.viewCount})`
    );

    if (cand.isUsaVerified || cand.isUkVerified || isClipSafe) {
      verifiedPool.push(cand);
    } else {
      fallbackPool.push(cand);
    }
  }

  verifiedPool.sort((a, b) => b.priorityScore - a.priorityScore);
  fallbackPool.sort((a, b) => b.priorityScore - a.priorityScore);

  return [...verifiedPool, ...fallbackPool].slice(0, 14);
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
    isUsaOrUk: Boolean(c.isUsaVerified || c.isUkVerified),
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
        contents: `You are a viral YouTube Shorts strategist growing a GTA 6 Shorts channel to 10M views for monetization (USA & UK audience).
Review these fresh, copyright-safe candidates and rank the TOP 8 videos from #1 (highest viral views potential) to #8.

STRICT PRIORITY ORDER:
1. COPYRIGHT-SAFE & CLIP-ALLOWED FIRST: Strongly favor isCreativeCommons=true, explicitClipPermission=true, or youtubeClipsEnabled=true.
2. HIGHEST VIRAL SHORTS HOOKS: GTA 6 Easter eggs, leaks, new hidden discoveries, GTA 6 vs GTA 5 / RDR2 comparisons, shocking details, or trending gameplay moments that make viewers watch to the end and replay.
3. USA / UK AUDIENCE APPEAL: Favor high viewCount, big creator authority, and high priorityScore. Reject boring clickbait or low-energy filler.

CANDIDATES:
${JSON.stringify(summaryRows, null, 2)}

Return the top ranked picks ordered from #1 (best) to #8.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              topPicks: {
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
        const picks = Array.isArray(parsed.topPicks) ? parsed.topPicks : [];
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
        // Append remaining unranked candidates as download fallbacks
        for (const c of candidates) {
          if (!ranked.some((r) => r.videoId === c.videoId)) {
            ranked.push(c);
          }
        }
        if (ranked.length > 0) {
          console.log('\n=== TOP VIRAL GTA 6 (USA/UK/GLOBAL • COPYRIGHT-SAFE) LEADERBOARD ===');
          ranked.slice(0, 5).forEach((item, i) => {
            const clipFlag = item.isCreativeCommons
              ? 'Creative Commons'
              : item.explicitClipPermission || item.aboutClipFriendly
                ? 'Clip Permitted'
                : item.youtubeClipsEnabled
                  ? 'YT Clips Enabled'
                  : 'Standard';
            console.log(
              `#${i + 1} [Score ${item.viralScore || item.priorityScore}/100] [${item.viralCategory || 'GTA 6'}] [${item.subscriberLabel} subs | ${clipFlag}] "${item.title}" by ${item.channel} (${item.creatorCountry}, views=${item.viewCount}) — ${item.viralReason || 'High viral score'}`
            );
          });
          console.log('====================================================================\n');
          return ranked;
        }
      }
    } catch (err) {
      console.warn(`Gemini viral ranking attempt (${model}) failed:`, err.message || err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return candidates;
}

function toAssTime(sec) {
  const csTotal = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(csTotal / 360000);
  const m = String(Math.floor((csTotal % 360000) / 6000)).padStart(2, '0');
  const s = String(Math.floor((csTotal % 6000) / 100)).padStart(2, '0');
  const cs = String(csTotal % 100).padStart(2, '0');
  return `${h}:${m}:${s}.${cs}`;
}

function escapeAssText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .trim();
}

function buildViralAssFile(clipPlan, start, duration) {
  const fontName = CAPTION_LANG === 'ur' ? 'Noto Sans Arabic' : 'DejaVu Sans';
  const hookText = escapeAssText(clipPlan.hookBanner || clipPlan.shortTitle || 'GTA 6 SECRET YOU MISSED').slice(0, 42).toUpperCase();
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${fontName},56,&H0000E5FF,&H000000FF,&H00000000,&HC0000000,-1,0,0,0,100,100,1,0,3,12,0,8,70,70,195,1
Style: Caption,${fontName},66,&H00FFFFFF,&H0000E5FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,5,3,2,65,65,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  const hookEnd = Math.min(duration, 4.2);
  if (hookText) {
    lines.push(`Dialogue: 1,${toAssTime(0)},${toAssTime(hookEnd)},Hook,,0,0,0,,${hookText}`);
  }

  const caps = Array.isArray(clipPlan.captions) && clipPlan.captions.length
    ? clipPlan.captions
    : [{ startSec: 0, endSec: Math.min(duration, 4), text: clipPlan.shortTitle || 'GTA 6 Viral Detail' }];

  for (const c of caps) {
    const rawStart = Number(c.startSec || 0);
    const rawEnd = Number(c.endSec || rawStart + 2.8);
    const relStart = rawStart >= start && start > 0 ? rawStart - start : rawStart;
    const relEnd = rawEnd >= start && start > 0 ? rawEnd - start : rawEnd;
    const clampedStart = Math.max(0, Math.min(duration - 0.4, relStart));
    const clampedEnd = Math.max(clampedStart + 0.4, Math.min(duration, relEnd));
    const cleanText = escapeAssText(c.text);
    if (cleanText) {
      lines.push(`Dialogue: 0,${toAssTime(clampedStart)},${toAssTime(clampedEnd)},Caption,,0,0,0,,${cleanText}`);
    }
  }

  return header + lines.join('\n') + '\n';
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
      ? 'Write hookBanner, shortTitle, shortDescription, and captions in crisp Urdu script.'
      : CAPTION_LANG === 'roman-ur'
        ? 'Write hookBanner, shortTitle, shortDescription, and captions in punchy Roman Urdu.'
        : 'Write hookBanner, shortTitle, shortDescription, hashtags, and EVERY caption line STRICTLY in punchy, high-retention viral English ONLY (2-4 words per caption line, natural YouTube Shorts style, ZERO Urdu or non-English characters).';

  const cleanTranscript = cleanVttTranscript(subtitleText);

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: `Analyze this viral GTA 6 video and pick ONE highest-retention ${CLIP_DURATION}-second vertical Short segment (28-48 seconds) designed to maximize Shorts views & watch-through rate (focus on the exact Easter egg reveal, leak bombshell, GTA 6 vs GTA 5/RDR2 comparison, or jaw-dropping hook).
Title: ${video.title}
Creator: ${video.channel || 'Creator'}
Description: ${String(video.description || '').slice(0, 400)}
Transcript excerpt: ${cleanTranscript}

STRICT OUTPUT LIMITS (keep JSON compact and valid):
- ${languageRule}
- hookBanner: 3 to 5 punchy uppercase words shown at the top for the first 4 seconds to stop scrolling (e.g. "GTA 6 SECRET YOU MISSED!").
- shortTitle: max 68 characters, irresistible curiosity-gap GTA 6 Shorts title.
- shortDescription: 1-2 short sentences (max 160 characters) summarizing the viral moment.
- hashtags: ONLY 4 to 5 high-reach hashtags (include #GTA6 #GTAVI #Gaming).
- captions: ONLY 10 to 16 caption objects covering 0 to ${CLIP_DURATION} seconds (2-4 punchy words per line). Never repeat captions.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              startSec: { type: Type.NUMBER },
              endSec: { type: Type.NUMBER },
              hookBanner: { type: Type.STRING },
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
          parsed.captions = parsed.captions.slice(0, 18);
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

async function uploadShortToYouTube(videoPath, clipPlan, sourceVideo) {
  const oauth2 = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const tags = Array.from(
    new Set(['GTA6', 'GTAVI', 'Shorts', 'Gaming', ...(clipPlan.hashtags || []).map((t) => t.replace(/^#/, ''))])
  ).slice(0, 12);
  const creditLine = sourceVideo?.channel
    ? `\n\nOriginal creator credit: ${sourceVideo.channel} (${sourceVideo.url})`
    : '';
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: `${clipPlan.shortTitle} #Shorts`.slice(0, 99),
        description: `${clipPlan.shortDescription}${creditLine}\n\n${(clipPlan.hashtags || []).join(' ')} #Shorts`,
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
  if (!rawCookies || !rawCookies.trim()) {
    console.warn('NOTICE: YOUTUBE_COOKIES secret is not set. On GitHub Cloud servers, add a throwaway/alt Google account cookies.txt in GitHub Secrets -> YOUTUBE_COOKIES to bypass YouTube bot checks.');
    return false;
  }
  let trimmed = rawCookies.trim();
  let format = 'netscape';
  let netscapeBody = '';

  // Support Base64-encoded cookies.txt automatically
  if (!trimmed.includes('\t') && !trimmed.includes('#') && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 80) {
    try {
      const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
      if (decoded.includes('youtube.com') || decoded.includes('google.com') || decoded.startsWith('#') || decoded.startsWith('[')) {
        trimmed = decoded;
        format = 'base64-decoded';
      }
    } catch {
      // Fall through to raw parsing
    }
  }

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
  const formatSelector =
    durationSec > 1200
      ? 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b'
      : 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b';

  const jsRuntime = process.platform === 'linux' ? 'deno,node' : 'node';
  const proxyUrl = (process.env.YTDLP_PROXY || '').trim();
  const proxyArgs = proxyUrl ? ['--proxy', proxyUrl] : [];

  const baseArgs = [
    '--js-runtimes', jsRuntime,
    '--sleep-requests', '1',
    '--retries', '2',
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '--match-filter', '!is_live',
    '-o', 'source.%(ext)s',
  ];

  const bgutilArgs =
    process.env.GITHUB_ACTIONS && process.platform === 'linux'
      ? ['--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416']
      : [];

  const strategies = [];
  if (hasCookies) {
    strategies.push({
      label: 'cookies + direct + default client + bgutil PO token',
      extraArgs: ['--force-ipv4', '--cookies', 'cookies.txt', ...bgutilArgs],
    });
    strategies.push({
      label: 'cookies + direct + web/mweb/tv + bgutil PO token',
      extraArgs: ['--force-ipv4', '--cookies', 'cookies.txt', ...bgutilArgs, '--extractor-args', 'youtube:player_client=web,mweb,tv'],
    });
    strategies.push({
      label: 'cookies + direct (pure yt-dlp without bgutil)',
      extraArgs: ['--force-ipv4', '--cookies', 'cookies.txt'],
    });
    if (proxyUrl) {
      strategies.push({
        label: 'cookies + WARP/proxy + web/mweb/tv + bgutil PO token',
        extraArgs: [...proxyArgs, '--force-ipv4', '--cookies', 'cookies.txt', ...bgutilArgs, '--extractor-args', 'youtube:player_client=web,mweb,tv'],
      });
    }
  }
  if (proxyUrl) {
    strategies.push({
      label: 'WARP/proxy + tv_embedded/android_vr/mweb + bgutil PO token',
      extraArgs: [...proxyArgs, '--force-ipv4', ...bgutilArgs, '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,mweb'],
    });
    strategies.push({
      label: 'WARP/proxy + web_safari/ios/tv + bgutil PO token',
      extraArgs: [...proxyArgs, '--force-ipv4', ...bgutilArgs, '--extractor-args', 'youtube:player_client=web_safari,ios,tv'],
    });
  }
  strategies.push({
    label: 'direct + tv_embedded/android_vr/web_safari + bgutil PO token',
    extraArgs: ['--force-ipv4', ...bgutilArgs, '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,web_safari'],
  });
  strategies.push({
    label: 'direct + default yt-dlp client',
    extraArgs: ['--force-ipv4', ...bgutilArgs],
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
    throw lastError || new Error('All yt-dlp download strategies failed. Add a throwaway Google account cookies.txt into GitHub Secret YOUTUBE_COOKIES.');
  }

  try {
    const subArgs = ['--js-runtimes', jsRuntime, '--skip-download', '--write-auto-sub', '--sub-format', 'vtt', '-o', 'source.%(ext)s'];
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
      throw new Error('Video download was skipped or source.mp4 was not created.');
    }

    const vttFile = fs.readdirSync('.').find((f) => f.startsWith('source.') && f.endsWith('.vtt'));
    const subtitleText = vttFile ? fs.readFileSync(vttFile, 'utf8') : chosenVideo.description;

    const clipPlan = await detectViralClipWithGemini(chosenVideo, subtitleText);
    const totalDuration = getVideoDurationSec('source.mp4');
    if (totalDuration < 15) {
      throw new Error(`Downloaded source video too short (${totalDuration}s); skipping.`);
    }

    let start = Math.max(0, Math.floor(clipPlan.startSec || 10));
    let duration = Math.min(56, Math.max(20, Math.floor((clipPlan.endSec || start + CLIP_DURATION) - start)));
    if (start >= totalDuration - 15) start = 0;
    duration = Math.min(duration, Math.max(15, Math.floor(totalDuration - start)));

    const assBody = buildViralAssFile(clipPlan, start, duration);
    fs.writeFileSync('captions.ass', assBody, 'utf8');

    execFileSync('ffmpeg', [
      '-y',
      '-ss', String(start),
      '-i', 'source.mp4',
      '-t', String(duration),
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,eq=contrast=1.05:saturation=1.12,ass=captions.ass',
      '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      'output_short.mp4',
    ], { stdio: 'inherit' });

    await uploadShortToYouTube('output_short.mp4', clipPlan, chosenVideo);
    history.uploadedClipKeys.push(chosenVideo.videoId);
    saveHistory(history);
  } finally {
    cleanupTempFiles();
  }
}

async function run() {
  if (!CHANNEL_IDS.length && DISCOVERY_MODE === 'channels_only') {
    throw new Error('Set SOURCE_CHANNEL_IDS or use DISCOVERY_MODE=hybrid / usa_viral.');
  }
  if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY secret.');
  if (!process.env.YOUTUBE_REFRESH_TOKEN) throw new Error('Missing YOUTUBE_REFRESH_TOKEN secret.');

  const history = loadHistory();
  let candidatePool = [];

  if (DISCOVERY_MODE !== 'channels_only') {
    const freshCandidates = await discoverLast24hGta6UsaCandidates(history);
    if (freshCandidates.length > 0) {
      candidatePool = await rankTop3ViralWithGemini(freshCandidates);
    }
  }

  if (DISCOVERY_MODE !== 'usa_viral') {
    for (const cid of CHANNEL_IDS) {
      try {
        const videos = await fetchLatestVideosFromRss(cid);
        for (const v of videos) {
          if (!history.uploadedClipKeys.includes(v.videoId) && !candidatePool.some((c) => c.videoId === v.videoId)) {
            candidatePool.push(v);
          }
        }
      } catch (err) {
        console.warn(`Fallback RSS fetch failed for ${cid}:`, err.message || err);
      }
    }
  }

  if (candidatePool.length === 0) {
    console.log('No new unclipped copyright-safe GTA 6 videos found in this window.');
    return;
  }

  let uploadedCount = 0;
  const maxAttempts = Math.min(candidatePool.length, MAX_CLIPS_PER_RUN + 5);

  for (let i = 0; i < maxAttempts && uploadedCount < MAX_CLIPS_PER_RUN; i++) {
    const video = candidatePool[i];
    try {
      await processAndUploadVideo(video, history);
      uploadedCount += 1;
    } catch (err) {
      console.warn(`Candidate #${i + 1} failed ("${video.title}"): ${err.message || err} — automatically trying next candidate...`);
    }
  }

  if (uploadedCount === 0) {
    throw new Error(`Tried ${maxAttempts} viral GTA 6 candidates but none could be downloaded/uploaded.`);
  }
  console.log(`Completed run cleanly: uploaded ${uploadedCount} Short(s).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
