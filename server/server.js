const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const PORT = Number(process.env.PORT) || 8787;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

const MEDIA_RE = {
  image: /\.(png|jpe?g|gif|webp|bmp)$/i,
  video: /\.(mp4|webm|mov|m4v)$/i,
  audio: /\.(mp3|wav|ogg|m4a|flac|opus)$/i
};

let config = loadConfig();
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

function findRoomByCode(code) {
  return config.rooms.find((r) => r.code === code) || null;
}

function findRoomByChannelId(channelId) {
  return config.rooms.find((r) => r.channelId === channelId) || null;
}

function broadcastToRoom(roomCode, payload) {
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
    const vidUrl = e.video?.url;
    if (vidUrl) {
      const c = vidUrl.split('?')[0];
      if (MEDIA_RE.video.test(c)) return { url: vidUrl, kind: 'video' };
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

function handleIncomingMessage(message) {
  const room = findRoomByChannelId(message.channelId);
  if (!room) return; // ce channel n'est pas mappe a une room

  const text = (message.content || '').trim();

  const fromAttach = pickMediaFromAttachments(message.attachments);
  if (fromAttach) {
    broadcastToRoom(room.code, { type: 'meme', mediaUrl: fromAttach.url, mediaKind: fromAttach.kind, text });
    return;
  }

  const urls = extractUrls(text);
  for (const u of urls) {
    const m = pickMediaFromUrl(u);
    if (m) {
      broadcastToRoom(room.code, { type: 'meme', mediaUrl: m.url, mediaKind: m.kind, text: cleanTextFromUrl(text, u) });
      return;
    }
  }

  const fromEmbedNow = pickMediaFromEmbeds(message.embeds);
  if (fromEmbedNow) {
    const usedUrl = urls[0];
    broadcastToRoom(room.code, {
      type: 'meme',
      mediaUrl: fromEmbedNow.url,
      mediaKind: fromEmbedNow.kind,
      text: usedUrl ? cleanTextFromUrl(text, usedUrl) : text
    });
    return;
  }

  if (urls.length > 0) {
    const onUpdate = (_oldMsg, newMsg) => {
      if (newMsg.id !== message.id) return;
      const m = pickMediaFromEmbeds(newMsg.embeds);
      if (m) {
        cleanup();
        broadcastToRoom(room.code, {
          type: 'meme',
          mediaUrl: m.url,
          mediaKind: m.kind,
          text: cleanTextFromUrl(text, urls[0])
        });
      }
    };
    const cleanup = () => {
      if (discordClient) discordClient.off('messageUpdate', onUpdate);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      if (text) broadcastToRoom(room.code, { type: 'meme', mediaUrl: null, mediaKind: null, text });
    }, 5000);
    if (discordClient) discordClient.on('messageUpdate', onUpdate);
    return;
  }

  if (text) broadcastToRoom(room.code, { type: 'meme', mediaUrl: null, mediaKind: null, text });
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
