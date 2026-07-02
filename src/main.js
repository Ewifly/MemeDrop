const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const WebSocket = require('ws');

// Autoriser autoplay sans gesture utilisateur (necessaire pour YouTube/TikTok dans l'overlay)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// =============================================================================
// CONSTANTES A EDITER AVANT DE BUILD POUR DISTRIBUTION
// =============================================================================
// URL du serveur MemeDrop (mets celle de ton VPS avant de build le .exe pour tes potes)
const DEFAULT_SERVER_URL = 'ws://57.131.40.94:8787';

// Mot de passe en dur qui protege l'acces au panneau admin de l'app cliente.
// Change-le avant de distribuer le .exe a tes amis.
const APP_ADMIN_PASSWORD = 'TonMdpAdmin';

// Repo GitHub (owner/repo) public qui heberge les .exe releases pour l'auto-update.
const UPDATE_REPO = 'LCournollet/memedrop-releases';
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
// =============================================================================

const store = new Store({
  defaults: {
    mode: null, // null | 'admin' | 'user'
    serverUrl: DEFAULT_SERVER_URL,
    serverAdminPassword: '',
    userCode: '',
    userCodes: [],     // multi-salon : liste des codes (priorite sur userCode legacy)
    overlayDurationMs: 8000,
    overlayPosition: 'bottom-right',
    overlayOpacity: 100, // 0-100, 100 = opaque
    autoLaunch: true,
    volume: 80,        // 0-100
    muted: false,
    disabled: false,
    displayName: '',           // (legacy, plus utilise) pseudo manuel
    displayAvatarUrl: '',      // (legacy, plus utilise) avatar manuel
    discordUserId: '',         // Discord User ID : le serveur fetch automatiquement pseudo + avatar
    favorites: []              // IDs des entries library mises en favori (local par user)
  }
});

// Migration : userCode (legacy) -> userCodes (array)
(function migrateUserCodes() {
  const codes = store.get('userCodes');
  if (Array.isArray(codes) && codes.length > 0) return;
  const legacy = store.get('userCode');
  if (legacy && typeof legacy === 'string') {
    store.set('userCodes', [legacy.trim()]);
  }
})();

// Statut du bot Discord (partage entre toutes les rooms)
let serverBotStatus = null;
// roomName par code (recu via WS hello)
let roomNameByCode = {};

// Info de mise a jour : { version, name, downloadUrl } | null
let updateInfo = null;
let updateDownloadState = 'idle'; // 'idle' | 'downloading' | 'ready' | 'error'

function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const res = await fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'MemeDrop-Updater' }
    });
    if (!res.ok) return;
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/i, '').trim();
    const current = app.getVersion();
    if (!latest) return;
    if (compareSemver(latest, current) <= 0) {
      // Pas de nouvelle version
      if (updateInfo) {
        updateInfo = null;
        notifyAllUpdate();
      }
      return;
    }
    const exeAsset = (data.assets || []).find((a) => /\.exe$/i.test(a.name));
    if (!exeAsset) return;
    updateInfo = {
      version: latest,
      name: data.name || ('MemeDrop v' + latest),
      downloadUrl: exeAsset.browser_download_url
    };
    notifyAllUpdate();
  } catch (_) { /* offline ou GitHub down */ }
}

function notifyAllUpdate() {
  const payload = {
    available: !!updateInfo,
    version: updateInfo?.version || null,
    name: updateInfo?.name || null,
    state: updateDownloadState
  };
  if (userWindow && !userWindow.isDestroyed()) {
    userWindow.webContents.send('update:status', payload);
  }
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.webContents.send('update:status', payload);
  }
}

async function downloadAndLaunchUpdate() {
  if (!updateInfo || !updateInfo.downloadUrl) return { ok: false, error: 'no_update' };
  updateDownloadState = 'downloading';
  notifyAllUpdate();
  try {
    const dest = path.join(app.getPath('temp'), 'MemeDrop-Setup-' + updateInfo.version + '.exe');
    const res = await fetch(updateInfo.downloadUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    updateDownloadState = 'ready';
    notifyAllUpdate();
    // Lance l'installeur puis quitte l'app pour qu'il puisse remplacer les fichiers
    await shell.openPath(dest);
    setTimeout(() => { app.isQuiting = true; app.quit(); }, 800);
    return { ok: true };
  } catch (e) {
    updateDownloadState = 'error';
    notifyAllUpdate();
    return { ok: false, error: e.message };
  }
}

function resolveIconPath() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  for (const name of ['icon.png', 'icon.jpg', 'icon.jpeg', 'icon.ico']) {
    const p = path.join(assetsDir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(assetsDir, 'icon.png');
}

const iconPath = resolveIconPath();

let tray = null;
let welcomeWindow = null;
let adminWindow = null;
let userWindow = null;
let libraryWindow = null;
let overlayWindow = null;
let trayPopupWindow = null;

// WS state : multi-connexion (un WS par code de salon en mode user)
let wsByCode = {};            // code -> WebSocket
let wsStateByCode = {};       // code -> 'connecting' | 'connected' | 'disconnected' | 'error'
let wsReconnectByCode = {};   // code -> setTimeout id
let wsAdmin = null;           // une seule WS pour le mode admin
let wsAdminState = 'idle';
let wsAdminReconnectTimer = null;

// --- helpers ---

function getTrayIcon() {
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img.resize({ width: 20, height: 20 });
  } catch (_) {}
  return nativeImage.createEmpty();
}

function ensureAutoLaunch() {
  if (process.platform !== 'win32') return;
  if (!app.isPackaged) return;
  const wanted = !!store.get('autoLaunch');
  try {
    app.setLoginItemSettings({
      openAtLogin: wanted,
      path: process.execPath,
      args: ['--hidden']
    });
  } catch (_) {}
}

function httpUrlFromWs(wsUrl) {
  return (wsUrl || '').replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/feed\/?.*$/, '');
}

// --- overlay ---

function createOverlayWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;
  const winWidth = 560;
  const winHeight = 460;

  overlayWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: width - winWidth - 24,
    y: height - winHeight - 24,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Necessaire pour permettre l'embed YouTube/TikTok dans l'overlay
      // (l'overlay ne charge que des medias publics, pas de risque)
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // Applique l'opacite configuree (100 = totalement opaque)
  try { overlayWindow.setOpacity(Math.max(0, Math.min(100, Number(store.get('overlayOpacity')) || 100)) / 100); } catch (_) {}

  // YouTube et TikTok envoient X-Frame-Options et CSP qui bloquent
  // l'embed iframe dans Chromium. On strip ces headers pour ces domaines.
  overlayWindow.webContents.session.webRequest.onHeadersReceived(
    {
      urls: [
        '*://*.youtube.com/*',
        '*://*.youtube-nocookie.com/*',
        '*://*.ytimg.com/*',
        '*://*.googlevideo.com/*',
        '*://*.tiktok.com/*',
        '*://*.tiktokcdn.com/*',
        '*://*.tiktokv.com/*'
      ]
    },
    (details, callback) => {
      const responseHeaders = {};
      for (const key in details.responseHeaders) {
        const lk = key.toLowerCase();
        if (lk === 'x-frame-options' ||
            lk === 'content-security-policy' ||
            lk === 'content-security-policy-report-only' ||
            lk === 'cross-origin-embedder-policy' ||
            lk === 'cross-origin-opener-policy' ||
            lk === 'cross-origin-resource-policy') {
          continue;
        }
        responseHeaders[key] = details.responseHeaders[key];
      }
      callback({ responseHeaders });
    }
  );

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

function positionOverlay(position) {
  if (!overlayWindow) return;
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;
  const [w, h] = overlayWindow.getSize();
  const margin = 24;
  const positions = {
    'top-left': [margin, margin],
    'top-right': [width - w - margin, margin],
    'bottom-left': [margin, height - h - margin],
    'bottom-right': [width - w - margin, height - h - margin],
    'center': [Math.floor((width - w) / 2), Math.floor((height - h) / 2)]
  };
  const [x, y] = positions[position] || positions['bottom-right'];
  overlayWindow.setPosition(x, y);
}

function showMeme({ mediaUrl, mediaKind, audioUrl, text, author, source, customDuration, forceDuration, startTime }) {
  if (store.get('disabled')) return; // user a coupe la reception
  if (!overlayWindow) createOverlayWindow();
  positionOverlay(store.get('overlayPosition'));
  // duration custom (commande Discord ":15") override la config locale, capee a 60s
  const baseDuration = customDuration && customDuration > 0
    ? Math.min(60000, customDuration)
    : store.get('overlayDurationMs');
  const duration = baseDuration;
  const muted = !!store.get('muted');
  const volume = Math.max(0, Math.min(100, Number(store.get('volume')) || 0));

  const send = () => {
    overlayWindow.webContents.send('meme:show', {
      mediaUrl: mediaUrl || null,
      mediaKind: mediaKind || null,
      audioUrl: audioUrl || null,
      text: text || '',
      author: author || null,
      source: source || null,
      duration,
      forceDuration: !!forceDuration,
      startTime: typeof startTime === 'number' && startTime > 0 ? startTime : null,
      volume,
      muted
    });
    // Re-affirme le topmost a chaque show : certaines apps (jeux, video
    // players) creent leur fenetre en topmost APRES le demarrage de l'overlay,
    // ce qui peut cacher notre overlay. On force la priorite a nouveau.
    try {
      overlayWindow.setAlwaysOnTop(false);
      overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    } catch (_) {}
    overlayWindow.showInactive();
    try { overlayWindow.moveTop(); } catch (_) {}
  };

  if (overlayWindow.webContents.isLoading()) {
    overlayWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// --- WebSocket client (multi-connexion mode user, simple mode admin) ---

function feedBaseUrl() {
  const base = store.get('serverUrl');
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/feed';
}

// Parse un code d'invitation qui peut etre soit un simple code de salon
// ("lycee2025"), soit un code compose avec l'URL du serveur
// ("lycee2025@wss://mon-serveur.exemple.com"). Ca permet a un admin de
// partager une seule chaine a copier-coller a ses amis, qui configure
// automatiquement le bon serveur cote User.
function parseInviteCode(raw) {
  const s = String(raw || '').trim();
  const atIndex = s.indexOf('@');
  if (atIndex === -1) return { code: s, serverUrl: null };
  const code = s.slice(0, atIndex).trim();
  const maybeUrl = s.slice(atIndex + 1).trim();
  if (/^wss?:\/\//i.test(maybeUrl)) {
    return { code, serverUrl: maybeUrl.replace(/\/+$/, '') };
  }
  // Partie apres @ ne ressemble pas a une URL ws(s) valide : on garde
  // la chaine complete comme code plutot que de risquer de couper un
  // code de salon qui contiendrait un @ pour une autre raison.
  return { code: s, serverUrl: null };
}

function handleWsMessage(msg) {
  if (msg.type === 'hello') {
    serverBotStatus = msg.status || serverBotStatus;
    if (msg.room) roomNameByCode[msg.room] = msg.roomName || null;
    notifyUserState();
    notifyAdminStatus();
  }
  if (msg.type === 'update-available') {
    // Le serveur a detecte une nouvelle release sur GitHub -> on re-check immediat
    checkForUpdate();
  }
  if (msg.type === 'meme') {
    showMeme({
      mediaUrl: msg.mediaUrl,
      mediaKind: msg.mediaKind,
      audioUrl: msg.audioUrl || null,
      text: msg.text,
      author: msg.author,
      source: msg.source || null,
      customDuration: msg.duration || null,
      forceDuration: !!msg.forceDuration,
      startTime: typeof msg.startTime === 'number' ? msg.startTime : null
    });
  }
}

// Connecte une WS user pour un code de salon
function connectUserWs(code) {
  if (!code) return;
  closeUserWs(code);
  const base = feedBaseUrl();
  if (!base) { wsStateByCode[code] = 'no_url'; notifyUserState(); return; }

  const wsUrl = base + '?code=' + encodeURIComponent(code);
  wsStateByCode[code] = 'connecting';
  notifyUserState();

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (_) {
    wsStateByCode[code] = 'error';
    notifyUserState();
    scheduleUserReconnect(code);
    return;
  }
  wsByCode[code] = ws;

  ws.on('open', () => { wsStateByCode[code] = 'connected'; notifyUserState(); });
  ws.on('message', (data) => {
    try { handleWsMessage(JSON.parse(data.toString())); } catch (_) {}
  });
  ws.on('close', () => {
    wsStateByCode[code] = 'disconnected';
    notifyUserState();
    scheduleUserReconnect(code);
  });
  ws.on('error', () => {
    wsStateByCode[code] = 'error';
    notifyUserState();
  });
}

function closeUserWs(code) {
  if (wsReconnectByCode[code]) { clearTimeout(wsReconnectByCode[code]); delete wsReconnectByCode[code]; }
  const ws = wsByCode[code];
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch (_) {}
    delete wsByCode[code];
  }
}

function scheduleUserReconnect(code) {
  if (wsReconnectByCode[code]) return;
  // Si le code n'est plus dans la liste, on reconnecte pas
  const current = (store.get('userCodes') || []).map(String);
  if (!current.includes(code)) return;
  wsReconnectByCode[code] = setTimeout(() => {
    delete wsReconnectByCode[code];
    connectUserWs(code);
  }, 5000);
}

function connectAdminWs() {
  closeAdminWs();
  const base = feedBaseUrl();
  const pwd = store.get('serverAdminPassword');
  if (!base || !pwd) { wsAdminState = 'no_url'; notifyAdminStatus(); return; }
  wsAdminState = 'connecting';
  notifyAdminStatus();

  try {
    wsAdmin = new WebSocket(base + '?admin=' + encodeURIComponent(pwd));
  } catch (_) {
    wsAdminState = 'error';
    notifyAdminStatus();
    scheduleAdminReconnect();
    return;
  }
  wsAdmin.on('open', () => { wsAdminState = 'connected'; notifyAdminStatus(); });
  wsAdmin.on('message', (data) => {
    try { handleWsMessage(JSON.parse(data.toString())); } catch (_) {}
  });
  wsAdmin.on('close', () => {
    wsAdminState = 'disconnected';
    notifyAdminStatus();
    scheduleAdminReconnect();
  });
  wsAdmin.on('error', () => { wsAdminState = 'error'; notifyAdminStatus(); });
}

function closeAdminWs() {
  if (wsAdminReconnectTimer) { clearTimeout(wsAdminReconnectTimer); wsAdminReconnectTimer = null; }
  if (wsAdmin) {
    try { wsAdmin.removeAllListeners(); wsAdmin.close(); } catch (_) {}
    wsAdmin = null;
  }
}

function scheduleAdminReconnect() {
  if (wsAdminReconnectTimer) return;
  wsAdminReconnectTimer = setTimeout(() => {
    wsAdminReconnectTimer = null;
    if (store.get('mode') === 'admin') connectAdminWs();
  }, 5000);
}

// Point d'entree : connecte tout selon le mode
function connectAllWs() {
  closeAllWs();
  const mode = store.get('mode');
  if (mode === 'admin') {
    connectAdminWs();
  } else if (mode === 'user') {
    const codes = (store.get('userCodes') || []).filter(Boolean);
    for (const code of codes) connectUserWs(code);
  }
}

function closeAllWs() {
  closeAdminWs();
  for (const code of Object.keys(wsByCode)) closeUserWs(code);
  for (const code of Object.keys(wsReconnectByCode)) {
    clearTimeout(wsReconnectByCode[code]);
    delete wsReconnectByCode[code];
  }
  wsByCode = {};
  wsStateByCode = {};
}

function aggregateUserWsState() {
  const codes = (store.get('userCodes') || []).filter(Boolean);
  if (codes.length === 0) return 'no_url';
  let anyConnected = false;
  let allError = true;
  for (const code of codes) {
    const s = wsStateByCode[code];
    if (s === 'connected') { anyConnected = true; allError = false; }
    else if (s !== 'error' && s !== 'no_url' && s) allError = false;
  }
  if (anyConnected) return 'connected';
  if (allError) return 'error';
  return 'connecting';
}

function notifyAdminStatus() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.webContents.send('ws:status', { state: wsAdminState });
  }
}

function buildRoomsState() {
  const codes = (store.get('userCodes') || []).filter(Boolean);
  return codes.map((code) => ({
    code,
    roomName: roomNameByCode[code] || null,
    wsState: wsStateByCode[code] || 'idle'
  }));
}

function notifyUserState() {
  if (userWindow && !userWindow.isDestroyed()) {
    userWindow.webContents.send('user:state', {
      rooms: buildRoomsState(),
      serverStatus: serverBotStatus,
      wsState: aggregateUserWsState(),
      volume: store.get('volume'),
      muted: store.get('muted'),
      disabled: store.get('disabled'),
      autoLaunch: store.get('autoLaunch'),
      overlayPosition: store.get('overlayPosition'),
      overlayOpacity: store.get('overlayOpacity')
    });
  }
}

// --- HTTP helpers ---

async function adminFetch(pathname, options = {}) {
  const httpBase = httpUrlFromWs(store.get('serverUrl'));
  if (!httpBase) return { ok: false, status: 0, body: { error: 'no_server_url' } };
  const url = httpBase + pathname;
  const headers = {
    'Content-Type': 'application/json',
    'X-Admin-Password': store.get('serverAdminPassword') || ''
  };
  try {
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message } };
  }
}

// Fetch authentifie par codes user OU mdp admin selon le mode courant.
async function userOrAdminFetch(pathname, options = {}) {
  const httpBase = httpUrlFromWs(store.get('serverUrl'));
  if (!httpBase) return { ok: false, status: 0, body: { error: 'no_server_url' } };
  const url = httpBase + pathname;
  const mode = store.get('mode');
  const headers = { 'Content-Type': 'application/json' };
  if (mode === 'admin') {
    headers['X-Admin-Password'] = store.get('serverAdminPassword') || '';
  } else {
    const codes = (store.get('userCodes') || []).filter(Boolean);
    headers['X-User-Codes'] = codes.join(',');
  }
  try {
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message } };
  }
}

// --- Windows ---

function createWelcomeWindow() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    if (!welcomeWindow.isVisible()) welcomeWindow.show();
    if (welcomeWindow.isMinimized()) welcomeWindow.restore();
    welcomeWindow.focus();
    return;
  }
  welcomeWindow = new BrowserWindow({
    width: 520,
    height: 460,
    resizable: false,
    title: 'MemeDrop',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  welcomeWindow.setMenu(null);
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'));
  // Welcome = ecran d'onboarding : on ne demande pas "que faire au close"
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function createLibraryWindow() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    if (!libraryWindow.isVisible()) libraryWindow.show();
    if (libraryWindow.isMinimized()) libraryWindow.restore();
    libraryWindow.focus();
    return;
  }
  libraryWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'MemeDrop - Bibliotheque',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  libraryWindow.setMenu(null);
  libraryWindow.loadFile(path.join(__dirname, 'library.html'));
  attachCloseBehavior(libraryWindow);
  libraryWindow.on('closed', () => { libraryWindow = null; });
}

function createUserWindow() {
  if (userWindow && !userWindow.isDestroyed()) {
    if (!userWindow.isVisible()) userWindow.show();
    if (userWindow.isMinimized()) userWindow.restore();
    userWindow.focus();
    return;
  }
  userWindow = new BrowserWindow({
    width: 460,
    height: 540,
    resizable: false,
    title: 'MemeDrop',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  userWindow.setMenu(null);
  userWindow.loadFile(path.join(__dirname, 'user.html'));
  attachCloseBehavior(userWindow);
  userWindow.on('closed', () => { userWindow = null; });
}

function createAdminWindow() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    if (!adminWindow.isVisible()) adminWindow.show();
    if (adminWindow.isMinimized()) adminWindow.restore();
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 620,
    height: 820,
    resizable: true,
    title: 'MemeDrop - Admin',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  adminWindow.setMenu(null);
  adminWindow.loadFile(path.join(__dirname, 'admin.html'));
  attachCloseBehavior(adminWindow);
  adminWindow.on('closed', () => { adminWindow = null; });
}

function attachCloseBehavior(win) {
  // Clic sur la croix = cache la fenetre dans le tray (icone fleche en bas
  // a droite). Pour quitter completement, utiliser "Quitter MemeDrop" dans
  // la page ou "Quitter" dans le menu tray (clic droit).
  win.on('close', (e) => {
    if (app.isQuiting) return;
    e.preventDefault();
    win.hide();
  });
}

function createTrayPopupWindow() {
  if (trayPopupWindow) return;
  trayPopupWindow = new BrowserWindow({
    width: 280,
    height: 240,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    transparent: false,
    movable: false,
    fullscreenable: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  trayPopupWindow.setMenu(null);
  trayPopupWindow.loadFile(path.join(__dirname, 'tray-popup.html'));
  trayPopupWindow.on('blur', () => {
    if (trayPopupWindow && trayPopupWindow.isVisible()) trayPopupWindow.hide();
  });
}

function positionTrayPopup() {
  if (!trayPopupWindow || !tray) return;
  const bounds = tray.getBounds();
  const [w, h] = trayPopupWindow.getSize();
  const primary = screen.getPrimaryDisplay();
  const sw = primary.workAreaSize.width;
  const sh = primary.workAreaSize.height;
  let x = Math.round(bounds.x + bounds.width / 2 - w / 2);
  let y = bounds.y - h - 8;
  if (y < 0) y = bounds.y + bounds.height + 8;
  if (x + w > sw) x = sw - w - 4;
  if (x < 4) x = 4;
  if (y + h > sh) y = sh - h - 4;
  trayPopupWindow.setPosition(x, y);
}

function toggleTrayPopup() {
  if (!trayPopupWindow) createTrayPopupWindow();
  if (trayPopupWindow.isVisible()) {
    trayPopupWindow.hide();
    return;
  }
  positionTrayPopup();
  trayPopupWindow.show();
  trayPopupWindow.focus();
}

// --- Tray ---

function buildTrayMenu() {
  const mode = store.get('mode');
  const items = [
    { label: `MemeDrop (${mode || 'non configure'})`, enabled: false },
    { type: 'separator' },
    {
      label: 'Ouvrir l\'app',
      click: () => openApp()
    },
    {
      label: 'Recevoir les memes',
      type: 'checkbox',
      checked: !store.get('disabled'),
      click: (item) => {
        store.set('disabled', !item.checked);
        notifyPopupState();
      }
    },
    {
      label: 'Test overlay (local)',
      click: () => showMeme({ text: 'Test MemeDrop !', mediaUrl: null, mediaKind: null })
    }
  ];

  if (mode === 'user') {
    const codes = (store.get('userCodes') || []).filter(Boolean);
    items.push({
      label: codes.length === 0
        ? 'Aucun salon'
        : codes.length === 1
        ? `Salon: ${codes[0]}`
        : `Salons: ${codes.join(', ')}`,
      enabled: false
    });
  }

  items.push(
    { label: 'Reconnecter au serveur', click: () => connectAllWs() },
    { type: 'separator' },
    {
      label: 'Lancer au demarrage',
      type: 'checkbox',
      checked: store.get('autoLaunch'),
      click: (item) => {
        store.set('autoLaunch', item.checked);
        ensureAutoLaunch();
      }
    },
    {
      label: 'Changer de mode',
      click: () => goBackToWelcome()
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuiting = true; app.quit(); } }
  );
  return Menu.buildFromTemplate(items);
}

function openApp() {
  const mode = store.get('mode');
  if (mode === 'admin') createAdminWindow();
  else if (mode === 'user') createUserWindow();
  else createWelcomeWindow();
  if (trayPopupWindow && trayPopupWindow.isVisible()) trayPopupWindow.hide();
}

function notifyPopupState() {
  if (trayPopupWindow && !trayPopupWindow.isDestroyed()) {
    trayPopupWindow.webContents.send('popup:state', {
      volume: store.get('volume'),
      muted: store.get('muted'),
      disabled: store.get('disabled')
    });
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function goBackToWelcome() {
  store.set('mode', null);
  closeAllWs();
  serverBotStatus = null;
  roomNameByCode = {};
  if (adminWindow && !adminWindow.isDestroyed()) { adminWindow.destroy(); adminWindow = null; }
  if (userWindow && !userWindow.isDestroyed()) { userWindow.destroy(); userWindow = null; }
  if (libraryWindow && !libraryWindow.isDestroyed()) { libraryWindow.destroy(); libraryWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createWelcomeWindow();
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('MemeDrop');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleTrayPopup());
  tray.on('double-click', () => openApp());
}

// --- IPC ---

ipcMain.handle('welcome:choose-user', (_e, code) => {
  const { code: c, serverUrl } = parseInviteCode(code);
  if (!c) return false;
  if (serverUrl) store.set('serverUrl', serverUrl);
  store.set('mode', 'user');
  store.set('userCode', c); // legacy compat
  store.set('userCodes', [c]);
  if (welcomeWindow && !welcomeWindow.isDestroyed()) { welcomeWindow.destroy(); welcomeWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createUserWindow();
  connectAllWs();
  return true;
});

ipcMain.handle('welcome:choose-admin', (_e, pwd) => {
  if (pwd !== APP_ADMIN_PASSWORD) return false;
  store.set('mode', 'admin');
  if (welcomeWindow && !welcomeWindow.isDestroyed()) { welcomeWindow.destroy(); welcomeWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createAdminWindow();
  connectAllWs();
  return true;
});

ipcMain.handle('user:get-state', () => ({
  rooms: buildRoomsState(),
  serverStatus: serverBotStatus,
  wsState: aggregateUserWsState(),
  volume: store.get('volume'),
  muted: store.get('muted'),
  disabled: store.get('disabled'),
  autoLaunch: store.get('autoLaunch'),
  overlayPosition: store.get('overlayPosition'),
  overlayOpacity: store.get('overlayOpacity')
}));

ipcMain.handle('user:add-code', (_e, code) => {
  const { code: c, serverUrl } = parseInviteCode(code);
  if (!c) return { ok: false, error: 'empty' };
  const codes = (store.get('userCodes') || []).map(String);
  if (codes.includes(c)) return { ok: false, error: 'duplicate' };
  const urlChanged = serverUrl && serverUrl !== store.get('serverUrl');
  if (serverUrl) store.set('serverUrl', serverUrl);
  codes.push(c);
  store.set('userCodes', codes);
  if (urlChanged) connectAllWs();
  else connectUserWs(c);
  notifyUserState();
  return { ok: true };
});

ipcMain.handle('user:remove-code', (_e, code) => {
  const c = String(code || '').trim();
  if (!c) return { ok: false };
  const codes = (store.get('userCodes') || []).map(String).filter((x) => x !== c);
  store.set('userCodes', codes);
  closeUserWs(c);
  delete roomNameByCode[c];
  notifyUserState();
  return { ok: true };
});

ipcMain.handle('common:set-auto-launch', (_e, enabled) => {
  store.set('autoLaunch', !!enabled);
  ensureAutoLaunch();
  if (tray) tray.setContextMenu(buildTrayMenu());
  return !!enabled;
});

ipcMain.handle('common:set-overlay-position', (_e, pos) => {
  const allowed = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  if (!allowed.includes(pos)) return false;
  store.set('overlayPosition', pos);
  // Repositionne tout de suite l'overlay
  positionOverlay(pos);
  notifyUserState();
  return true;
});

ipcMain.handle('common:set-overlay-opacity', (_e, opacity) => {
  const o = Math.max(0, Math.min(100, Number(opacity) || 0));
  store.set('overlayOpacity', o);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.setOpacity(o / 100); } catch (_) {}
  }
  notifyUserState();
  return o;
});

ipcMain.handle('common:quit-app', () => {
  app.isQuiting = true;
  app.quit();
  return true;
});

ipcMain.handle('update:get', () => ({
  available: !!updateInfo,
  version: updateInfo?.version || null,
  name: updateInfo?.name || null,
  state: updateDownloadState,
  currentVersion: app.getVersion()
}));

ipcMain.handle('update:check-now', async () => {
  await checkForUpdate();
  return { ok: true };
});

ipcMain.handle('update:download', async () => {
  return await downloadAndLaunchUpdate();
});

// --- Library ---

ipcMain.handle('library:open', () => {
  createLibraryWindow();
  return true;
});

ipcMain.handle('library:list', async (_e, opts) => {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return await userOrAdminFetch('/library' + (qs ? '?' + qs : ''));
});

ipcMain.handle('library:send', async (_e, data) => {
  return await userOrAdminFetch('/library/send', {
    method: 'POST',
    body: JSON.stringify({
      mediaUrl: data.mediaUrl || '',
      text: data.text || '',
      roomCode: data.roomCode || '',
      senderDiscordId: (store.get('discordUserId') || '').trim()
    })
  });
});

ipcMain.handle('identity:get', () => ({
  discordUserId: store.get('discordUserId') || ''
}));

ipcMain.handle('identity:set', (_e, data) => {
  if (typeof data?.discordUserId === 'string') {
    // Garde uniquement les chiffres (les User ID Discord sont des snowflakes numeriques)
    const cleaned = data.discordUserId.replace(/\D+/g, '');
    store.set('discordUserId', cleaned);
  }
  return true;
});

// Favoris (local par user)
ipcMain.handle('favorites:get', () => {
  const favs = store.get('favorites');
  return Array.isArray(favs) ? favs : [];
});

ipcMain.handle('favorites:toggle', (_e, id) => {
  if (!id) return { ok: false };
  const favs = (store.get('favorites') || []).filter(Boolean);
  const i = favs.indexOf(id);
  if (i >= 0) {
    favs.splice(i, 1);
    store.set('favorites', favs);
    return { ok: true, favorited: false };
  }
  favs.unshift(id);
  store.set('favorites', favs);
  return { ok: true, favorited: true };
});

ipcMain.handle('library:rooms', () => {
  // Renvoie les rooms ou l'user peut envoyer (codes connus dans son userCodes,
  // ou tous les rooms si admin avec roomName quand dispo).
  const mode = store.get('mode');
  if (mode === 'admin') {
    // On va chercher la liste cote serveur via adminFetch
    return adminFetch('/admin/status').then((r) => {
      if (!r.ok) return [];
      return (r.body.rooms || []).map((rr) => ({ code: rr.code, name: rr.name || '' }));
    });
  }
  // User : on liste les codes + le roomName si on l'a recu via WS hello
  const codes = (store.get('userCodes') || []).filter(Boolean);
  return codes.map((c) => ({ code: c, name: roomNameByCode[c] || '' }));
});

ipcMain.handle('admin:get-state', () => ({
  serverUrl: store.get('serverUrl'),
  serverAdminPassword: store.get('serverAdminPassword'),
  overlayPosition: store.get('overlayPosition'),
  overlayDurationMs: store.get('overlayDurationMs'),
  autoLaunch: store.get('autoLaunch'),
  wsState: wsAdminState
}));

ipcMain.handle('admin:save-local', (_e, data) => {
  if (typeof data.serverUrl === 'string') store.set('serverUrl', data.serverUrl.trim());
  if (typeof data.serverAdminPassword === 'string') store.set('serverAdminPassword', data.serverAdminPassword);
  if (typeof data.overlayPosition === 'string') store.set('overlayPosition', data.overlayPosition);
  if (data.overlayDurationMs) store.set('overlayDurationMs', Number(data.overlayDurationMs) || 8000);
  if (typeof data.autoLaunch === 'boolean') store.set('autoLaunch', data.autoLaunch);
  ensureAutoLaunch();
  if (tray) tray.setContextMenu(buildTrayMenu());
  connectAllWs();
  return true;
});

ipcMain.handle('admin:push-token', async (_e, token) => {
  return await adminFetch('/admin/token', {
    method: 'POST',
    body: JSON.stringify({ botToken: token })
  });
});

ipcMain.handle('admin:add-room', async (_e, room) => {
  return await adminFetch('/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({
      code: room.code,
      channelId: room.channelId,
      name: room.name || ''
    })
  });
});

ipcMain.handle('admin:delete-room', async (_e, code) => {
  return await adminFetch('/admin/rooms/' + encodeURIComponent(code), { method: 'DELETE' });
});

ipcMain.handle('admin:server-status', async () => {
  return await adminFetch('/admin/status', { method: 'GET' });
});

ipcMain.handle('admin:broadcast-test', async (_e, code) => {
  return await adminFetch('/admin/test', {
    method: 'POST',
    body: JSON.stringify(code ? { code } : {})
  });
});

ipcMain.handle('admin:test-overlay-local', () => {
  showMeme({ text: 'Test MemeDrop (local) !', mediaUrl: null, mediaKind: null });
  return true;
});

ipcMain.handle('common:open-link', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('common:back-to-welcome', () => {
  goBackToWelcome();
  return true;
});

// Tray popup
ipcMain.handle('popup:get-state', () => ({
  volume: store.get('volume'),
  muted: store.get('muted'),
  disabled: store.get('disabled')
}));

function notifyOverlayAudio() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:audio', {
      volume: store.get('volume'),
      muted: !!store.get('muted')
    });
  }
}

function broadcastAudioState() {
  notifyOverlayAudio();
  notifyPopupState();
  notifyUserState();
}

ipcMain.handle('popup:set-volume', (_e, v) => {
  const vol = Math.max(0, Math.min(100, Number(v) || 0));
  store.set('volume', vol);
  broadcastAudioState();
  return vol;
});

ipcMain.handle('popup:set-muted', (_e, m) => {
  store.set('muted', !!m);
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcastAudioState();
  return !!m;
});

ipcMain.handle('popup:set-disabled', (_e, d) => {
  store.set('disabled', !!d);
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcastAudioState();
  return !!d;
});

ipcMain.handle('popup:open-app', () => {
  openApp();
  return true;
});

ipcMain.handle('popup:hide', () => {
  if (trayPopupWindow) trayPopupWindow.hide();
  return true;
});

// --- bootstrap ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openApp());

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.memedrop.app');
    createTray();
    createOverlayWindow();
    ensureAutoLaunch();

    const mode = store.get('mode');
    if (!mode) {
      createWelcomeWindow();
    } else {
      if (!process.argv.includes('--hidden')) {
        if (mode === 'admin') createAdminWindow();
        else if (mode === 'user') createUserWindow();
      }
      connectAllWs();
    }
    // Check pour les mises a jour au demarrage et toutes les heures
    setTimeout(checkForUpdate, 3000); // delai pour pas saturer le boot
    setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  });

  app.on('window-all-closed', (e) => { e.preventDefault(); });
  app.on('before-quit', () => { closeAllWs(); });
}