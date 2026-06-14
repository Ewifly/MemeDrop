const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const PORT = Number(process.env.PORT) || 8787;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const LIBRARY_PATH = process.env.LIBRARY_PATH || path.join(__dirname, 'library.json');
const LIBRARY_MAX_ENTRIES = 5000;

const MEDIA_RE = {
  image: /\.(png|jpe?g|gif|webp|bmp)$/i,
  video: /\.(mp4|webm|mov|m4v)$/i,
  audio: /\.(mp3|wav|ogg|m4a|flac|opus)$/i
};

let config = loadConfig();
let library = loadLibrary();
let discordClient = null;
let reconnectTimer = null;
let discordStatus = 'stopped';
let discordTag = '';

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      botToken: raw.botToken || '',
      rooms: Array.isArray(raw.rooms) ? raw.rooms : []
    };
  } catch (_) {
    return { botToken: '', rooms: [] };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Bibliotheque ---

function loadLibrary() {
  try {
    const raw = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.entries)) return raw.entries;
    return [];
  } catch (_) {
    return [];
  }
}

let librarySaveTimer = null;
function saveLibrary() {
  // Debounce les ecritures (les memes arrivent en rafale parfois)
  if (librarySaveTimer) return;
  librarySaveTimer = setTimeout(() => {
    librarySaveTimer = null;
    try { fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2)); }
    catch (e) { console.error('[library] save error:', e.message); }
  }, 2000);
}

function libraryHash(s) {
  // Hash simple non cryptographique pour dedup
  let h = 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return 'e' + Math.abs(h).toString(36);
}

function addToLibrary({ mediaUrl, mediaKind, audioUrl, text, author, source }) {
  // On stocke uniquement si il y a un media (les texte-seuls ne servent a rien dans la lib)
  if (!mediaUrl) return;
  const id = libraryHash(mediaUrl);
  const existing = library.find((e) => e.id === id);
  if (existing) {
    existing.usageCount = (existing.usageCount || 1) + 1;
    existing.lastSeenAt = Date.now();
    saveLibrary();
    return;
  }
  const entry = {
    id,
    mediaUrl,
    mediaKind: mediaKind || 'image',
    audioUrl: audioUrl || null,
    text: text || '',
    author: author || null,
    source: source || null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    usageCount: 1
  };
  library.unshift(entry);
  if (library.length > LIBRARY_MAX_ENTRIES) {
    library.length = LIBRARY_MAX_ENTRIES;
  }
  saveLibrary();
}

function findRoomByCode(code) {
  return config.rooms.find((r) => r.code === code) || null;
}

function findRoomByChannelId(channelId) {
  return config.rooms.find((r) => r.channelId === channelId) || null;
}

function broadcastToRoom(roomCode, payload) {
  // Capture dans la bibliotheque (sauf si pas de media)
  if (payload && payload.type === 'meme' && payload.mediaUrl) {
    addToLibrary({
      mediaUrl: payload.mediaUrl,
      mediaKind: payload.mediaKind,
      audioUrl: payload.audioUrl,
      text: payload.text,
      author: payload.author,
      source: payload.source
    });
  }
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws._admin || ws._room === roomCode) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

function broadcastToAll(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

function pickMediaFromAttachments(attachments) {
  if (!attachments || !attachments.size) return null;
  for (const a of attachments.values()) {
    const ct = (a.contentType || '').toLowerCase();
    const name = (a.name || a.url || '').split('?')[0];
    if (ct.startsWith('image/') || MEDIA_RE.image.test(name)) return { url: a.url, kind: 'image' };
    if (ct.startsWith('video/') || MEDIA_RE.video.test(name)) return { url: a.url, kind: 'video' };
    if (ct.startsWith('audio/') || MEDIA_RE.audio.test(name)) return { url: a.url, kind: 'audio' };
  }
  return null;
}

const TIKTOK_LONG_RE = /tiktok\.com\/(?:@[^/]+\/(?:video|photo)\/|v\/)([0-9]+)/i;
const TIKTOK_PHOTO_RE = /tiktok\.com\/@[^/]+\/photo\/[0-9]+/i;
const TIKTOK_SHORT_RE = /(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i;

function extractTikTokId(url) {
  if (!url) return null;
  const m = String(url).match(TIKTOK_LONG_RE);
  return m ? m[1] : null;
}

// Resout les short URLs tiktok (vm.tiktok.com / vt.tiktok.com) vers leur URL longue
// pour en extraire le video ID. Retourne null si echec.
async function resolveTikTokShortUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, { method: 'HEAD', redirect: 'follow' });
    return extractTikTokId(res.url);
  } catch (_) {
    return null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Recupere les infos TikTok via tikwm. Renvoie soit :
// - { kind: 'video', url: mp4Url }
// - { kind: 'image-audio', imageUrl, audioUrl } pour les TikTok photo+audio
// - null en cas d'echec
async function resolveTikTokDirectMp4(originalUrl, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const apiUrl = 'https://tikwm.com/api/?url=' + encodeURIComponent(originalUrl);
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeDrop)' }
      });
      if (!res.ok) {
        console.log(`[tikwm] HTTP ${res.status} attempt ${i + 1}/${attempts}`);
        if (i < attempts - 1) await sleep(1500);
        continue;
      }
      const data = await res.json();
      if (data && data.code === 0 && data.data) {
        // TikTok photo+audio : data.images (array) + data.music
        if (Array.isArray(data.data.images) && data.data.images.length > 0) {
          const imageUrl = data.data.images[0];
          const audioUrl = data.data.music || null;
          return { kind: 'image-audio', imageUrl, audioUrl };
        }
        // TikTok video classique
        const play = data.data.play || data.data.wmplay;
        if (play) return { kind: 'video', url: play };
      }
      // Rate limited / video privee / autre
      const msg = (data && data.msg) || 'unknown';
      console.log(`[tikwm] code=${data && data.code} msg="${msg}" attempt ${i + 1}/${attempts}`);
      if (data && data.code === -1 && i < attempts - 1) {
        await sleep(2000);
        continue;
      }
      return null;
    } catch (e) {
      console.log(`[tikwm] error attempt ${i + 1}/${attempts}: ${e.message}`);
      if (i < attempts - 1) await sleep(1500);
    }
  }
  return null;
}

const INSTAGRAM_RE = /instagram\.com\/(reel|reels|p)\/([A-Za-z0-9_-]+)/i;
const TWITTER_RE = /(?:twitter\.com|x\.com)\/([^/\s?#]+)\/status\/(\d+)/i;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function ytDlpGetUrlOnce(originalUrl, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let proc;
    try {
      proc = spawn('yt-dlp', [
        '-g',
        '-f', 'best[ext=mp4]/best',
        '--no-warnings',
        '--no-playlist',
        '--socket-timeout', '12',
        '--user-agent', MOBILE_UA,
        originalUrl
      ]);
    } catch (e) {
      console.log(`[yt-dlp] spawn error: ${e.message}`);
      return resolve(null);
    }
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      console.log(`[yt-dlp] timeout after ${timeoutMs}ms for ${originalUrl}`);
      try { proc.kill(); } catch (_) {}
      resolve(null);
    }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      if (killed) return;
      console.log(`[yt-dlp] proc error: ${e.message}`);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      const ms = Date.now() - t0;
      if (code !== 0) {
        const lastErr = err.trim().split('\n').pop() || '';
        console.log(`[yt-dlp] exit ${code} (${ms}ms) :: ${lastErr.slice(0, 200)}`);
        return resolve(null);
      }
      const url = (out.trim().split('\n')[0] || '').trim();
      if (!url || !url.startsWith('http')) {
        console.log(`[yt-dlp] invalid url output (${ms}ms): ${out.slice(0, 200)}`);
        return resolve(null);
      }
      console.log(`[yt-dlp] OK (${ms}ms) ${originalUrl}`);
      resolve(url);
    });
  });
}

// Wrapper avec retry : TikTok flag parfois les requetes consecutives, un retry
// apres delai resout souvent le probleme.
async function ytDlpGetUrl(originalUrl, timeoutMs = 25000, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const url = await ytDlpGetUrlOnce(originalUrl, timeoutMs);
    if (url) return url;
    if (i < attempts - 1) {
      const wait = 1500 + i * 1000; // 1.5s, 2.5s
      console.log(`[yt-dlp] retry ${i + 2}/${attempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  return null;
}

function guessKindFromUrl(url) {
  const c = url.split('?')[0].split('#')[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v|m3u8)$/i.test(c)) return 'video';
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(c)) return 'image';
  if (/\.(mp3|wav|ogg|m4a|flac|opus)$/i.test(c)) return 'audio';
  return 'video'; // par defaut, on suppose video (cas du streaming)
}

// Instagram : utilise yt-dlp (les proxies publics ddinstagram/etc sont morts)
async function resolveInstagramMedia(originalUrl) {
  const direct = await ytDlpGetUrl(originalUrl);
  if (direct) return { url: direct, kind: guessKindFromUrl(direct) };
  return null;
}

// Twitter/X : essaie vxtwitter API (rapide, JSON propre), fallback yt-dlp
async function resolveTwitterMedia(originalUrl) {
  try {
    const m = String(originalUrl).match(TWITTER_RE);
    if (m) {
      const apiUrl = 'https://api.vxtwitter.com/' + encodeURIComponent(m[1]) + '/status/' + m[2];
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeDrop)' }
      });
      if (res.ok) {
        const data = await res.json();
        const items = (data && data.media_extended) || [];
        for (const it of items) {
          if (!it || !it.url) continue;
          if (it.type === 'video' || it.type === 'gif') return { url: it.url, kind: 'video' };
          if (it.type === 'image') return { url: it.url, kind: 'image' };
        }
      }
    }
  } catch (_) {}
  // Fallback yt-dlp
  const direct = await ytDlpGetUrl(originalUrl);
  if (direct) return { url: direct, kind: guessKindFromUrl(direct) };
  return null;
}

function pickMediaFromUrl(url) {
  const cleaned = url.split('?')[0].split('#')[0];
  if (MEDIA_RE.image.test(cleaned)) return { url, kind: 'image' };
  if (MEDIA_RE.video.test(cleaned)) return { url, kind: 'video' };
  if (MEDIA_RE.audio.test(cleaned)) return { url, kind: 'audio' };
  return null;
}

function pickMediaFromEmbeds(embeds) {
  if (!embeds || !embeds.length) return null;
  for (const e of embeds) {
    // Pour les embeds TikTok : on accepte UNIQUEMENT le MP4 direct dans
    // embed.video.url. Pas de fallback iframe TikTok (cookie wall non cliquable).
    // Si pas de MP4 direct, on prend la thumbnail comme image statique.
    const isTikTokEmbed = extractTikTokId(e.url) || extractTikTokId(e.video?.url);

    const vidUrl = e.video?.url;
    if (vidUrl) {
      const c = vidUrl.split('?')[0];
      if (MEDIA_RE.video.test(c)) return { url: vidUrl, kind: 'video' };
    }

    if (isTikTokEmbed) {
      // TikTok embed sans MP4 direct -> fallback thumbnail statique
      if (e.thumbnail?.url) return { url: e.thumbnail.url, kind: 'image' };
      if (e.image?.url) return { url: e.image.url, kind: 'image' };
      continue;
    }

    if (e.image?.url) return { url: e.image.url, kind: 'image' };
    if (e.thumbnail?.url) return { url: e.thumbnail.url, kind: 'image' };
  }
  return null;
}

function extractUrls(text) {
  return text.match(/https?:\/\/[^\s<>]+/g) || [];
}

function cleanTextFromUrl(text, url) {
  return text.replace(url, '').replace(/\s+/g, ' ').trim();
}

// Parse une commande de duree custom en fin de texte: ":15", ":15s", ":60s"
// Retourne { text: texteNettoye, duration: msNumber | null }. Cap a 60s.
function parseCustomDuration(text) {
  if (!text) return { text: text || '', duration: null };
  const re = /\s*:(\d{1,2})s?\s*$/i;
  const m = text.match(re);
  if (!m) return { text, duration: null };
  const n = parseInt(m[1], 10);
  if (isNaN(n) || n < 1) return { text, duration: null };
  const duration = Math.min(60, n) * 1000;
  const cleaned = text.replace(re, '').trim();
  return { text: cleaned, duration };
}

// Parse une commande de timestamp de depart en fin de texte: "/5", "/30"
// Retourne { text: texteNettoye, startTime: secondsNumber | null }
// Necessite un espace avant le '/' pour ne pas confondre avec une URL.
function parseStartTime(text) {
  if (!text) return { text: text || '', startTime: null };
  const re = /\s+\/(\d{1,3})\s*$/i;
  const m = text.match(re);
  if (!m) return { text, startTime: null };
  const n = parseInt(m[1], 10);
  if (isNaN(n) || n < 0) return { text, startTime: null };
  const cleaned = text.replace(re, '').trim();
  return { text: cleaned, startTime: n };
}

async function handleIncomingMessage(message) {
  const room = findRoomByChannelId(message.channelId);
  if (!room) return; // ce channel n'est pas mappe a une room

  const rawText = (message.content || '').trim();
  // Parse les commandes en fin de texte : ":Ns" pour duree, "/N" pour timestamp de depart.
  // Les deux peuvent etre combines dans n'importe quel ordre.
  let textAfterCmds = rawText;
  let customDuration = null;
  let startTime = null;
  for (let i = 0; i < 2; i++) {
    const dur = parseCustomDuration(textAfterCmds);
    if (dur.duration != null) { customDuration = dur.duration; textAfterCmds = dur.text; continue; }
    const st = parseStartTime(textAfterCmds);
    if (st.startTime != null) { startTime = st.startTime; textAfterCmds = st.text; continue; }
    break;
  }
  const text = textAfterCmds;
  const author = {
    name: message.member?.displayName || message.author.globalName || message.author.username,
    avatarUrl: message.author.displayAvatarURL({ size: 128, extension: 'png' })
  };
  // Source = provenance Discord : nom du serveur + icone du serveur (guild)
  // Fallback sur le nom de la room MemeDrop si pas d'info guild.
  const source = {
    guildName: message.guild?.name || null,
    guildIcon: message.guild?.iconURL?.({ size: 128, extension: 'png' }) || null,
    roomName: room.name || null,
    roomCode: room.code
  };

  // helper pour construire le payload meme avec la duration custom propagee
  // forceDuration: true indique au client d'utiliser duration tel quel
  // (sans le combiner avec la duree du media)
  // startTime: secondes pour demarrer la lecture (video/audio) plus tard
  const meme = (extra) => ({
    type: 'meme',
    author,
    source,
    duration: customDuration,
    forceDuration: customDuration != null,
    startTime,
    ...extra
  });

  const fromAttach = pickMediaFromAttachments(message.attachments);
  if (fromAttach) {
    broadcastToRoom(room.code, meme({ mediaUrl: fromAttach.url, mediaKind: fromAttach.kind, text }));
    return;
  }

  const urls = extractUrls(text);
  for (const u of urls) {
    // TikTok : essayer tikwm puis yt-dlp en fallback (les 2 evitent le cookie wall)
    if (TIKTOK_LONG_RE.test(u) || TIKTOK_SHORT_RE.test(u)) {
      const tt = await resolveTikTokDirectMp4(u);
      if (tt && tt.kind === 'image-audio') {
        broadcastToRoom(room.code, meme({
          mediaUrl: tt.imageUrl,
          mediaKind: 'image-audio',
          audioUrl: tt.audioUrl,
          text: cleanTextFromUrl(text, u)
        }));
        return;
      }
      let mp4 = tt && tt.kind === 'video' ? tt.url : null;
      if (!mp4) {
        // Fallback yt-dlp (gere mieux le rate limit / videos privees / variants)
        mp4 = await ytDlpGetUrl(u);
      }
      if (mp4) {
        broadcastToRoom(room.code, meme({ mediaUrl: mp4, mediaKind: 'video', text: cleanTextFromUrl(text, u) }));
        return;
      }
      // Pas de fallback iframe : cause un cookie wall qu'on peut pas cliquer.
      // On laisse le flow continuer pour potentiellement chopper la thumbnail via embed Discord.
    }

    // Instagram (reel/reels/p) : resolution media direct via yt-dlp
    if (INSTAGRAM_RE.test(u)) {
      const ig = await resolveInstagramMedia(u);
      if (ig) {
        broadcastToRoom(room.code, meme({ mediaUrl: ig.url, mediaKind: ig.kind, text: cleanTextFromUrl(text, u) }));
        return;
      }
    }

    // Twitter/X : resolution video via vxtwitter API (rapide) ou yt-dlp en fallback
    if (TWITTER_RE.test(u)) {
      const tw = await resolveTwitterMedia(u);
      if (tw) {
        broadcastToRoom(room.code, meme({ mediaUrl: tw.url, mediaKind: tw.kind, text: cleanTextFromUrl(text, u) }));
        return;
      }
    }

    const m = pickMediaFromUrl(u);
    if (m) {
      broadcastToRoom(room.code, meme({ mediaUrl: m.url, mediaKind: m.kind, text: cleanTextFromUrl(text, u) }));
      return;
    }
  }

  const fromEmbedNow = pickMediaFromEmbeds(message.embeds);
  if (fromEmbedNow) {
    const usedUrl = urls[0];
    broadcastToRoom(room.code, meme({
      mediaUrl: fromEmbedNow.url,
      mediaKind: fromEmbedNow.kind,
      text: usedUrl ? cleanTextFromUrl(text, usedUrl) : text
    }));
    return;
  }

  if (urls.length > 0) {
    const onUpdate = (_oldMsg, newMsg) => {
      if (newMsg.id !== message.id) return;
      const m = pickMediaFromEmbeds(newMsg.embeds);
      if (m) {
        cleanup();
        broadcastToRoom(room.code, meme({
          mediaUrl: m.url,
          mediaKind: m.kind,
          text: cleanTextFromUrl(text, urls[0])
        }));
      }
    };
    const cleanup = () => {
      if (discordClient) discordClient.off('messageUpdate', onUpdate);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      if (text) broadcastToRoom(room.code, meme({ mediaUrl: null, mediaKind: null, text }));
    }, 5000);
    if (discordClient) discordClient.on('messageUpdate', onUpdate);
    return;
  }

  if (text) broadcastToRoom(room.code, meme({ mediaUrl: null, mediaKind: null, text }));
}

function setStatus(status, tag = '') {
  discordStatus = status;
  discordTag = tag;
  console.log(`[discord] ${status}${tag ? ' as ' + tag : ''}`);
}

function startDiscord() {
  stopDiscord();
  if (!config.botToken) {
    setStatus('unconfigured');
    return;
  }
  setStatus('connecting');

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel]
  });

  discordClient.once('clientReady', () => {
    setStatus('connected', discordClient.user.tag);
  });

  discordClient.on('messageCreate', (message) => {
    if (message.author.bot) return;
    handleIncomingMessage(message);
  });

  discordClient.on('error', (err) => {
    setStatus('error: ' + err.message);
    scheduleReconnect();
  });

  discordClient.on('shardDisconnect', () => {
    setStatus('disconnected');
    scheduleReconnect();
  });

  discordClient.login(config.botToken).catch((err) => {
    setStatus('login_failed: ' + err.message);
    scheduleReconnect();
  });
}

function stopDiscord() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (discordClient) {
    try { discordClient.destroy(); } catch (_) {}
    discordClient = null;
  }
  setStatus('stopped');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startDiscord();
  }, 15000);
}

// --- HTTP server ---

function send(res, code, payload, type = 'application/json') {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
}

function checkAdmin(req) {
  const pwd = req.headers['x-admin-password'];
  return pwd && pwd === ADMIN_PASSWORD;
}

// Renvoie l'array de room codes que le client est autorise a manipuler.
// Admin = tous les rooms. User = uniquement ceux passes en header X-User-Codes.
function getAllowedRoomCodes(req) {
  if (checkAdmin(req)) {
    return config.rooms.map((r) => r.code);
  }
  const raw = req.headers['x-user-codes'];
  if (!raw) return [];
  const codes = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  // Filtrer ceux qui existent reellement
  const known = new Set(config.rooms.map((r) => r.code));
  return codes.filter((c) => known.has(c));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function countClientsPerRoom() {
  const map = {};
  for (const ws of clients) {
    if (ws._room) map[ws._room] = (map[ws._room] || 0) + 1;
  }
  return map;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/admin/status' && req.method === 'GET') {
    if (!checkAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    const perRoom = countClientsPerRoom();
    return send(res, 200, {
      status: discordStatus,
      tag: discordTag,
      clients: clients.size,
      hasToken: !!config.botToken,
      rooms: config.rooms.map((r) => ({
        code: r.code,
        channelId: r.channelId,
        name: r.name || '',
        connectedClients: perRoom[r.code] || 0
      }))
    });
  }

  if (url.pathname === '/admin/token' && req.method === 'POST') {
    if (!checkAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      if (typeof body.botToken !== 'string' || !body.botToken.trim()) {
        return send(res, 400, { error: 'missing_token' });
      }
      config.botToken = body.botToken.trim();
      saveConfig();
      startDiscord();
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'bad_json' });
    }
  }

  if (url.pathname === '/admin/rooms' && req.method === 'GET') {
    if (!checkAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    const perRoom = countClientsPerRoom();
    return send(res, 200, {
      rooms: config.rooms.map((r) => ({
        code: r.code,
        channelId: r.channelId,
        name: r.name || '',
        connectedClients: perRoom[r.code] || 0
      }))
    });
  }

  if (url.pathname === '/admin/rooms' && req.method === 'POST') {
    if (!checkAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const code = String(body.code || '').trim();
      const channelId = String(body.channelId || '').trim();
      const name = String(body.name || '').trim();
      if (!code || !channelId) return send(res, 400, { error: 'missing_fields' });
      const existing = findRoomByCode(code);
      if (existing) {
        existing.channelId = channelId;
        existing.name = name;
      } else {
        config.rooms.push({ code, channelId, name });
      }
      saveConfig();
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'bad_json' });
    }
  }

  const delMatch = url.pathname.match(/^\/admin\/rooms\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    if (!checkAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    const code = delMatch[1];
    const before = config.rooms.length;
    config.rooms = config.rooms.filter((r) => r.code !== code);
    saveConfig();
    return send(res, 200, { ok: true, removed: before - config.rooms.length });
  }

  if (url.pathname === '/admin/test' && req.method === 'POST') {
    if (!checkAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req).catch(() => ({}));
      const code = body && body.code;
      const payload = {
        type: 'meme',
        mediaUrl: null,
        mediaKind: null,
        text: code ? `Test broadcast salon ${code}` : 'Test broadcast (tous salons)'
      };
      if (code) broadcastToRoom(code, payload);
      else broadcastToAll(payload);
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'bad_json' });
    }
  }

  // Bibliotheque : liste paginee filtree par codes du user (ou tous si admin)
  if (url.pathname === '/library' && req.method === 'GET') {
    const allowedCodes = getAllowedRoomCodes(req);
    if (allowedCodes.length === 0) return send(res, 401, { error: 'unauthorized' });
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const allowedSet = new Set(allowedCodes);
    const filtered = library.filter((e) => e.source && allowedSet.has(e.source.roomCode));
    const slice = filtered.slice(offset, offset + limit);
    return send(res, 200, { total: filtered.length, entries: slice });
  }

  // Envoyer un media (depuis la bibliotheque ou directement) vers un salon
  // Body : { mediaUrl, mediaKind?, text?, roomCode } - poste le media dans le channel Discord
  if (url.pathname === '/library/send' && req.method === 'POST') {
    const allowedCodes = getAllowedRoomCodes(req);
    if (allowedCodes.length === 0) return send(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const targetCode = String(body.roomCode || '').trim();
      const mediaUrl = String(body.mediaUrl || '').trim();
      const text = String(body.text || '').trim();
      if (!targetCode) return send(res, 400, { error: 'missing_roomCode' });
      if (!mediaUrl && !text) return send(res, 400, { error: 'missing_content' });
      if (!allowedCodes.includes(targetCode)) return send(res, 403, { error: 'forbidden_room' });
      const room = findRoomByCode(targetCode);
      if (!room) return send(res, 404, { error: 'room_not_found' });
      if (!discordClient || discordStatus !== 'connected') {
        return send(res, 503, { error: 'bot_not_connected' });
      }
      try {
        const channel = discordClient.channels.cache.get(room.channelId)
          || await discordClient.channels.fetch(room.channelId);
        if (!channel || !channel.send) return send(res, 502, { error: 'channel_unavailable' });
        // On poste le texte + URL (Discord auto-embed)
        const content = [text, mediaUrl].filter(Boolean).join('\n');
        await channel.send({ content });
        return send(res, 200, { ok: true });
      } catch (e) {
        console.error('[library/send] discord error:', e.message);
        return send(res, 500, { error: 'discord_send_failed', detail: e.message });
      }
    } catch {
      return send(res, 400, { error: 'bad_json' });
    }
  }

  send(res, 404, { error: 'not_found' });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/feed') {
    socket.destroy();
    return;
  }

  const adminParam = url.searchParams.get('admin');
  const code = url.searchParams.get('code');

  // Auth admin via mdp
  if (adminParam) {
    if (adminParam !== ADMIN_PASSWORD) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._admin = true;
      ws._room = null;
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', status: discordStatus, tag: discordTag, admin: true }));
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
    return;
  }

  // Auth user via code de salon
  if (!code) { socket.destroy(); return; }
  const room = findRoomByCode(code);
  if (!room) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._admin = false;
    ws._room = room.code;
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', status: discordStatus, tag: discordTag, room: room.code, roomName: room.name }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
});

server.listen(PORT, () => {
  console.log(`[memedrop-server] listening on :${PORT}`);
  startDiscord();
});

process.on('SIGTERM', () => { stopDiscord(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { stopDiscord(); server.close(() => process.exit(0)); });
