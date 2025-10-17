/*
  sol-intel-bot — Telegram bot for /intel <CA> [N]
  Dependencies: telegraf, axios, dotenv
*/

const { Telegraf } = require('telegraf');
const axios = require('axios');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required. Set it in your .env');
}

const HELIUS_KEY = process.env.HELIUS_KEY || '';
const X_BEARER = process.env.X_BEARER || '';
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || '';
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || '0') === '1';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const PORT = Number(process.env.PORT || 3000);

const bot = new Telegraf(BOT_TOKEN);

const http = axios.create({
  timeout: 15000,
  headers: {
    'user-agent': 'sol-intel-bot/0.1 (+https://github.com/)'
  },
  validateStatus: (s) => s >= 200 && s < 400, // allow 3xx when needed (Wayback id_ pages)
});

// Simple per (chatId:userId) rate limiter
const RATE_LIMIT_MS = 3000;
const lastInvocationAtMsByKey = new Map();

function shouldRateLimit(ctx) {
  const key = `${ctx.chat?.id || 'unknown'}:${ctx.from?.id || 'unknown'}`;
  const now = Date.now();
  const last = lastInvocationAtMsByKey.get(key) || 0;
  if (now - last < RATE_LIMIT_MS) return true;
  lastInvocationAtMsByKey.set(key, now);
  return false;
}

// Base58 (no 0 O I l) length 32–44
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// MarkdownV2 escaping for Telegram
function escapeMDV2(text) {
  if (text == null) return '';
  return String(text)
    .replace(/[_*\[\]()~`>#+\-=|{}.!]/g, (m) => `\\${m}`);
}

function mdv2Link(label, url) {
  // do not escape URL; Telegram expects raw URL inside () for MarkdownV2
  // but we percent-encode closing parens if any
  const safeUrl = String(url || '').replace(/\)/g, '%29');
  return `[${escapeMDV2(label)}](${safeUrl})`;
}

function shortenCA(ca) {
  if (!ca || ca.length <= 14) return ca;
  return `${ca.slice(0, 6)}…${ca.slice(-6)}`;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseIntelArgs(text) {
  // Supports: /intel <CA> [N] and /intel@Bot <CA> [N]; quotes allowed for CA
  const m = text.match(/^\/intel(?:@\w+)?\s+("[^"]+"|'[^']+'|\S+)(?:\s+(\d{1,2}))?/i);
  if (!m) return null;
  const caRaw = stripQuotes(m[1]);
  const nRaw = m[2] ? Number(m[2]) : undefined;
  return { ca: caRaw, n: nRaw };
}

function isValidMint(ca) {
  return BASE58_RE.test(ca);
}

// Social normalization
function normalizeXHandle(input) {
  if (!input) return null;
  let s = String(input).trim();
  // accept URLs
  const urlMatch = s.match(/^https?:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(?:\b|\/|\?)?/i);
  if (urlMatch) s = urlMatch[1];
  // accept @handle
  if (s.startsWith('@')) s = s.slice(1);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return null;
  return `@${s}`;
}

function normalizeTelegram(input) {
  if (!input) return null;
  let s = String(input).trim();
  // URL forms
  const urlMatch = s.match(/^https?:\/\/(?:t\.me|telegram\.me|telegram\.org)\/([A-Za-z0-9_]{3,64})/i);
  if (urlMatch) return `https://t.me/${urlMatch[1]}`;
  // @channel
  const atMatch = s.match(/^@([A-Za-z0-9_]{3,64})$/);
  if (atMatch) return `https://t.me/${atMatch[1]}`;
  return null;
}

function normalizeWebsite(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

async function fetchDexScreenerSocials(ca) {
  try {
    const endpoints = [
      `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(ca)}`,
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(ca)}`,
    ];
    let pairs = [];
    for (const url of endpoints) {
      try {
        const res = await http.get(url);
        if (Array.isArray(res.data)) {
          pairs = res.data;
        } else if (res.data && Array.isArray(res.data.pairs)) {
          pairs = res.data.pairs;
        }
        if (pairs.length) break;
      } catch (_) { /* continue */ }
    }
    if (!pairs.length) return {};

    // Pick pair with highest liquidity
    let best = null;
    let bestLiq = -1;
    for (const p of pairs) {
      const liq = Number(p?.liquidity?.usd ?? p?.liquidity ?? 0);
      if (liq > bestLiq) {
        bestLiq = liq;
        best = p;
      }
    }
    const info = best?.info || {};
    const socials = Array.isArray(info.socials) ? info.socials : [];
    let xHandle, telegram, website;

    for (const s of socials) {
      const platform = String(s?.platform || '').toLowerCase();
      const url = s?.url || '';
      if (!xHandle && (platform === 'twitter' || platform === 'x')) {
        xHandle = normalizeXHandle(url);
      }
      if (!telegram && platform === 'telegram') {
        telegram = normalizeTelegram(url);
      }
      if (!website && (platform === 'website' || platform === 'site')) {
        website = normalizeWebsite(url);
      }
    }
    if (!website && info.website) {
      website = normalizeWebsite(info.website);
    }

    return { xHandle, telegram, website };
  } catch (_) {
    return {};
  }
}

async function fetchHeliusSocials(ca) {
  if (!HELIUS_KEY) return {};
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`;
    const body = {
      jsonrpc: '2.0',
      id: '1',
      method: 'getAsset',
      params: { id: String(ca) },
    };
    const res = await http.post(url, body, { headers: { 'content-type': 'application/json' } });
    const links = res?.data?.result?.content?.links || {};
    const xHandle = normalizeXHandle(links.twitter || links.x);
    const telegram = normalizeTelegram(links.telegram);
    const website = normalizeWebsite(links.external_url);
    return { xHandle, telegram, website };
  } catch (_) {
    return {};
  }
}

async function fetchBirdeyeSocials(ca) {
  if (!BIRDEYE_KEY) return {};
  try {
    const url = `https://public-api.birdeye.so/public/token?address=${encodeURIComponent(ca)}`;
    const res = await http.get(url, { headers: { 'X-API-KEY': BIRDEYE_KEY } });
    const d = res?.data?.data || {};
    const socials = d.socials || {};
    const xHandle = normalizeXHandle(socials.twitter || socials.x);
    const telegram = normalizeTelegram(socials.telegram);
    const website = normalizeWebsite(d.website || d.site || socials.website || socials.site);
    return { xHandle, telegram, website };
  } catch (_) {
    return {};
  }
}

async function resolveSocials(ca) {
  // Prefer DexScreener, then Helius, then Birdeye
  const dex = await fetchDexScreenerSocials(ca);
  const hel = await fetchHeliusSocials(ca);
  const bir = await fetchBirdeyeSocials(ca);

  return {
    xHandle: dex.xHandle || hel.xHandle || bir.xHandle || null,
    telegram: dex.telegram || hel.telegram || bir.telegram || null,
    website: dex.website || hel.website || bir.website || null,
  };
}

async function resolveXUserId(xHandle) {
  if (!xHandle) return null;
  const username = xHandle.replace(/^@/, '');
  if (X_BEARER) {
    try {
      const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`;
      const res = await http.get(url, { headers: { Authorization: `Bearer ${X_BEARER}` } });
      const id = res?.data?.data?.id || res?.data?.data?.rest_id;
      if (id) return String(id);
    } catch (_) { /* fallback below */ }
  }
  // Fallback public endpoint
  try {
    const url = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${encodeURIComponent(username)}`;
    const res = await http.get(url, { headers: { 'accept': 'application/json' } });
    const arr = Array.isArray(res.data) ? res.data : [];
    const id = arr[0]?.id_str || arr[0]?.id;
    return id ? String(id) : null;
  } catch (_) {
    return null;
  }
}

// Wayback helpers
async function queryCDX(params) {
  const search = new URLSearchParams({ output: 'json', ...params });
  const url = `https://web.archive.org/cdx/search/cdx?${search.toString()}`;
  const res = await http.get(url);
  const data = res.data;
  if (!Array.isArray(data) || data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
}

function tsToDate(ts) {
  // Wayback timestamp like 20200131123456 -> 2020-01-31
  if (!ts || ts.length < 8) return 'unknown';
  return `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
}

function extractHandleFromRedirectHtml(html) {
  const m = String(html).match(/https?:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(?:\b|\/|\?)/i);
  return m ? `@${m[1]}` : null;
}

function extractUserIdFromHtml(html) {
  const s = String(html);
  let m = s.match(/\"rest_id\"\s*:\s*\"(\d{5,})\"/);
  if (m) return m[1];
  m = s.match(/data-user-id=\"(\d{5,})\"/);
  if (m) return m[1];
  m = s.match(/\"userId\"\s*:\s*\"(\d{5,})\"/);
  if (m) return m[1];
  return null;
}

async function getHandleHistoryFromWayback(userId, limit = 25) {
  try {
    const rows = await queryCDX({
      url: `twitter.com/i/user/${userId}`,
      fl: 'timestamp,original,statuscode',
      filter: 'statuscode:3..',
      collapse: 'timestamp:8',
      limit: String(Math.max(limit, 10)),
      // sorted ascending by default
    });
    const items = [];
    for (const r of rows) {
      if (!/^3\d\d$/.test(String(r.statuscode || ''))) continue;
      const ts = r.timestamp;
      const idUrl = `https://web.archive.org/web/${ts}id_/https://twitter.com/i/user/${userId}`;
      try {
        const res = await http.get(idUrl);
        const handle = extractHandleFromRedirectHtml(res.data);
        if (handle) items.push({ timestamp: ts, date: tsToDate(ts), handle });
      } catch (_) { /* skip */ }
      if (items.length >= limit) break;
    }
    // Deduplicate by handle and sort by ts
    const seen = new Set();
    const uniq = [];
    for (const it of items.sort((a,b)=>a.timestamp.localeCompare(b.timestamp))) {
      if (seen.has(it.handle)) continue;
      seen.add(it.handle);
      uniq.push(it);
    }
    return uniq;
  } catch (_) {
    return [];
  }
}

async function getEarliestArchivedUserIdForHandle(handle) {
  const username = handle.replace(/^@/, '');
  try {
    const rows = await queryCDX({
      url: `twitter.com/${username}`,
      fl: 'timestamp,original,statuscode,mimetype',
      filter: 'statuscode:200',
      limit: '5',
      sort: 'ascending',
    });
    for (const r of rows) {
      if (String(r.mimetype || '').toLowerCase() !== 'text/html') continue;
      const ts = r.timestamp;
      const idUrl = `https://web.archive.org/web/${ts}id_/https://twitter.com/${username}`;
      try {
        const res = await http.get(idUrl);
        const uid = extractUserIdFromHtml(res.data);
        if (uid) return { uid: String(uid), ts };
      } catch (_) { /* continue */ }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTweetTextFromHtml(html) {
  const s = String(html);
  // Try og:description
  let m = s.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (m) return decodeHtmlEntities(m[1]);
  // Try name="description"
  m = s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (m) return decodeHtmlEntities(m[1]);
  // Last resort: simple text node heuristic
  m = s.match(/data-aria-label-part=\"0\">([\s\S]*?)<\//i);
  if (m) return decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim();
  return '';
}

async function getDeletedTweetSamples(handle, sampleSize, bearer) {
  const username = handle.replace(/^@/, '');
  try {
    const rows = await queryCDX({
      url: `twitter.com/${username}/status/*`,
      fl: 'timestamp,original,statuscode',
      filter: 'statuscode:200',
      collapse: 'urlkey',
      limit: '1000',
    });

    // Group by tweet ID and pick earliest timestamp per id
    const idToTs = new Map();
    for (const r of rows) {
      const original = r.original || '';
      const m = original.match(/\/status\/(\d{5,})/);
      if (!m) continue;
      const id = m[1];
      const ts = r.timestamp;
      if (!idToTs.has(id) || ts < idToTs.get(id)) {
        idToTs.set(id, ts);
      }
    }

    const allIds = Array.from(idToTs.keys());
    if (!allIds.length) return [];

    let missingIds = allIds;
    if (bearer) {
      // Check existence via X API in chunks of 100
      const existing = new Set();
      for (let i = 0; i < allIds.length; i += 100) {
        const chunk = allIds.slice(i, i + 100);
        try {
          const url = `https://api.x.com/2/tweets?ids=${chunk.join(',')}&tweet.fields=id`;
          const res = await http.get(url, { headers: { Authorization: `Bearer ${bearer}` } });
          const data = Array.isArray(res?.data?.data) ? res.data.data : [];
          for (const t of data) existing.add(String(t.id));
        } catch (_) { /* ignore chunk */ }
      }
      missingIds = allIds.filter((id) => !existing.has(id));
    }

    // Sample up to sampleSize
    if (missingIds.length > sampleSize) {
      // simple random sample
      missingIds = missingIds.sort(() => Math.random() - 0.5).slice(0, sampleSize);
    }

    const items = [];
    for (const id of missingIds) {
      const ts = idToTs.get(id);
      const snapUrl = `https://web.archive.org/web/${ts}/https://twitter.com/${username}/status/${id}`;
      const idUrl = `https://web.archive.org/web/${ts}id_/https://twitter.com/${username}/status/${id}`;
      try {
        const res = await http.get(idUrl);
        const text = extractTweetTextFromHtml(res.data) || '(no text extracted)';
        items.push({ id, text, snapUrl, date: tsToDate(ts) });
      } catch (_) {
        items.push({ id, text: '(snapshot fetch failed)', snapUrl, date: tsToDate(ts) });
      }
      if (items.length >= sampleSize) break;
    }
    return items;
  } catch (_) {
    return [];
  }
}

function buildIntelMessage(opts) {
  const { ca, socials, userId, handleHistory, recycled, samples, notes } = opts;
  const lines = [];
  lines.push(`Intel for ${escapeMDV2(shortenCA(ca))}`);
  lines.push('');

  // 1) X/Twitter
  if (socials.xHandle) {
    const uname = socials.xHandle.replace(/^@/, '');
    lines.push(`1\) X/Twitter: ${escapeMDV2(socials.xHandle)} — ${mdv2Link(`https://x.com/${uname}`, `https://x.com/${uname}`)}`);
  } else {
    lines.push('1\) X/Twitter: not found');
  }

  // 2) Website
  lines.push(`2\) Website: ${socials.website ? mdv2Link(socials.website, socials.website) : 'not found'}`);

  // 3) Telegram
  lines.push(`3\) Telegram: ${socials.telegram ? mdv2Link(socials.telegram, socials.telegram) : 'not found'}`);

  // 4) Handle history
  if (userId && handleHistory?.length) {
    lines.push('4\) Handle history (Wayback):');
    for (const h of handleHistory) {
      lines.push(`\- ${escapeMDV2(h.date)} → ${escapeMDV2(h.handle)}`);
    }
  } else if (userId) {
    lines.push('4\) Handle history (Wayback): none found');
  } else {
    lines.push('4\) Handle history (Wayback): unavailable (missing userId)');
  }

  // 5) Recycled handle heuristic
  if (userId && typeof recycled?.isRecycled === 'boolean') {
    const status = recycled.isRecycled ? 'Yes' : 'No';
    lines.push(`5\) Recycled handle\?: ${status}`);
    if (recycled.note) lines.push(`\- ${escapeMDV2(recycled.note)}`);
  } else if (userId) {
    lines.push('5\) Recycled handle\?: unknown');
  } else {
    lines.push('5\) Recycled handle\?: unavailable (missing userId)');
  }

  // 6) Deleted/unavailable tweets sample
  if (socials.xHandle && samples?.length) {
    lines.push(`6\) Deleted\/unavailable tweets sample \(${samples.length}\):`);
    for (const s of samples) {
      const label = `"${s.text.slice(0, 240)}"`;
      lines.push(`\- ${escapeMDV2(s.date)} — ${escapeMDV2(label)} — ${mdv2Link('snapshot', s.snapUrl)}`);
    }
  } else if (socials.xHandle) {
    lines.push('6\) Deleted\/unavailable tweets sample: none found');
  } else {
    lines.push('6\) Deleted\/unavailable tweets sample: unavailable (no handle)');
  }

  // 7) Notes
  lines.push('7\) Notes:');
  for (const n of notes) lines.push(`\- ${escapeMDV2(n)}`);

  return lines.join('\n');
}

bot.command('intel', async (ctx) => {
  try {
    if (shouldRateLimit(ctx)) {
      return ctx.reply('Rate limit: please wait 3 seconds between requests.');
    }

    const args = parseIntelArgs(ctx.message.text || '');
    if (!args || !args.ca) {
      return ctx.replyWithMarkdownV2(escapeMDV2('Usage: /intel <CA> [N]\nCA: Solana base58 mint (32–44 chars). N: 1–25 (default 10).'));
    }
    const ca = args.ca.trim();
    if (!isValidMint(ca)) {
      return ctx.replyWithMarkdownV2(escapeMDV2('Invalid mint. Expecting base58 (32–44 chars).'));
    }
    const sampleSize = Math.max(1, Math.min(25, Number.isFinite(args.n) ? args.n : 10));

    await ctx.replyWithMarkdownV2(escapeMDV2(`Looking up intel for ${shortenCA(ca)}…`));

    const socials = await resolveSocials(ca);

    let userId = null;
    if (socials.xHandle) {
      userId = await resolveXUserId(socials.xHandle);
    }

    let handleHistory = [];
    if (userId) {
      handleHistory = await getHandleHistoryFromWayback(userId, 25);
    }

    let recycled = null;
    if (userId && socials.xHandle) {
      const earliest = await getEarliestArchivedUserIdForHandle(socials.xHandle);
      if (earliest && earliest.uid) {
        recycled = {
          isRecycled: String(earliest.uid) !== String(userId),
          note: `Earliest archived userId=${earliest.uid} vs current userId=${userId}`,
        };
      } else {
        recycled = { isRecycled: null, note: 'Could not extract earliest archived userId' };
      }
    }

    let samples = [];
    if (socials.xHandle) {
      samples = await getDeletedTweetSamples(socials.xHandle, sampleSize, X_BEARER || null);
    }

    const notes = [
      'Wayback coverage is incomplete; redirects and content may be missing or stale.',
      'Tweet text extraction from snapshots is best effort and may be truncated.',
      X_BEARER ? 'Deleted\/unavailable detection uses X API; protected tweets may appear missing.' : 'No X API token provided; deleted\/unavailable detection is limited.'
    ];

    const message = buildIntelMessage({ ca, socials, userId, handleHistory, recycled, samples, notes });
    return ctx.replyWithMarkdownV2(message, { disable_web_page_preview: true });
  } catch (err) {
    const msg = (err && err.message) ? String(err.message) : 'Unexpected error';
    return ctx.replyWithMarkdownV2(escapeMDV2(`Error: ${msg}`));
  }
});

async function launchBot() {
  if (USE_WEBHOOK) {
    if (!WEBHOOK_DOMAIN) {
      throw new Error('WEBHOOK_DOMAIN is required when USE_WEBHOOK=1');
    }
    await bot.launch({
      webhook: {
        domain: WEBHOOK_DOMAIN,
        port: PORT,
      },
    });
    console.log(`Bot launched (webhook) on port ${PORT}`);
  } else {
    await bot.launch();
    console.log('Bot launched (long polling)');
  }

  // Proper shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

launchBot().catch((e) => {
  console.error('Failed to launch bot:', e);
  process.exit(1);
});
