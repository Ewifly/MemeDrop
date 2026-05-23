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
// =============================================================================

const store = new Store({
  defaults: {
    mode: null, // null | 'admin' | 'user'
    serverUrl: DEFAULT_SERVER_URL,
    serverAdminPassword: '',
    userCode: '',
    overlayDurationMs: 8000,
    overlayPosition: 'bottom-right',
    autoLaunch: true,
    volume: 80,        // 0-100
    muted: false,
    disabled: false
  }
});

// Etat live du salon courant (recu via WS 'hello')
let currentRoomInfo = { room: null, roomName: null, serverStatus: null };

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
let overlayWindow = null;
let trayPopupWindow = null;
let ws = null;
let wsReconnectTimer = null;
let wsState = 'idle';

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
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

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

function showMeme({ mediaUrl, mediaKind, text }) {
  if (store.get('disabled')) return; // user a coupe la reception
  if (!overlayWindow) createOverlayWindow();
  positionOverlay(store.get('overlayPosition'));
  const duration = store.get('overlayDurationMs');
  const muted = !!store.get('muted');
  const volume = Math.max(0, Math.min(100, Number(store.get('volume')) || 0));

  const send = () => {
    overlayWindow.webContents.send('meme:show', {
      mediaUrl: mediaUrl || null,
      mediaKind: mediaKind || null,
      text: text || '',
      duration,
      volume,
      muted
    });
    overlayWindow.showInactive();
  };

  if (overlayWindow.webContents.isLoading()) {
    overlayWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// --- WebSocket client ---

function buildWsUrl() {
  const base = store.get('serverUrl');
  if (!base) return null;
  const mode = store.get('mode');
  const u = base.replace(/\/+$/, '') + '/feed';
  if (mode === 'user') {
    const code = store.get('userCode');
    if (!code) return null;
    return `${u}?code=${encodeURIComponent(code)}`;
  }
  if (mode === 'admin') {
    const adminPwd = store.get('serverAdminPassword');
    if (!adminPwd) return null;
    return `${u}?admin=${encodeURIComponent(adminPwd)}`;
  }
  return null;
}

function connectWs() {
  closeWs();

  const wsUrl = buildWsUrl();
  if (!wsUrl) {
    wsState = 'no_url';
    notifyAdminStatus();
    return;
  }

  wsState = 'connecting';
  notifyAdminStatus();

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    wsState = 'error';
    notifyAdminStatus();
    scheduleWsReconnect();
    return;
  }

  ws.on('open', () => {
    wsState = 'connected';
    notifyAdminStatus();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') {
        currentRoomInfo = {
          room: msg.room || null,
          roomName: msg.roomName || null,
          serverStatus: msg.status || null
        };
        notifyUserState();
      }
      if (msg.type === 'meme') {
        showMeme({ mediaUrl: msg.mediaUrl, mediaKind: msg.mediaKind, text: msg.text });
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    wsState = 'disconnected';
    notifyAdminStatus();
    scheduleWsReconnect();
  });

  ws.on('error', () => {
    wsState = 'error';
    notifyAdminStatus();
  });
}

function closeWs() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch (_) {}
    ws = null;
  }
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, 5000);
}

function notifyAdminStatus() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.webContents.send('ws:status', { state: wsState });
  }
  notifyUserState();
}

function notifyUserState() {
  if (userWindow && !userWindow.isDestroyed()) {
    userWindow.webContents.send('user:state', {
      code: store.get('userCode'),
      roomName: currentRoomInfo.roomName,
      serverStatus: currentRoomInfo.serverStatus,
      wsState,
      volume: store.get('volume'),
      muted: store.get('muted'),
      disabled: store.get('disabled'),
      autoLaunch: store.get('autoLaunch'),
      overlayPosition: store.get('overlayPosition')
    });
  }
}

// --- Admin HTTP helpers ---

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
  // Clic sur la croix = minimiser dans la barre des taches. Pour quitter
  // completement, utiliser le bouton "Quitter MemeDrop" dans la page,
  // ou "Quitter" dans le menu tray (clic droit).
  win.on('close', (e) => {
    if (app.isQuiting) return;
    e.preventDefault();
    win.minimize();
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
    items.push({
      label: `Code salon: ${store.get('userCode') || '-'}`,
      enabled: false
    });
  }

  items.push(
    { label: 'Reconnecter au serveur', click: () => connectWs() },
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
  closeWs();
  currentRoomInfo = { room: null, roomName: null, serverStatus: null };
  if (adminWindow && !adminWindow.isDestroyed()) { adminWindow.destroy(); adminWindow = null; }
  if (userWindow && !userWindow.isDestroyed()) { userWindow.destroy(); userWindow = null; }
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
  const c = String(code || '').trim();
  if (!c) return false;
  store.set('mode', 'user');
  store.set('userCode', c);
  if (welcomeWindow && !welcomeWindow.isDestroyed()) { welcomeWindow.destroy(); welcomeWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createUserWindow();
  connectWs();
  return true;
});

ipcMain.handle('welcome:choose-admin', (_e, pwd) => {
  if (pwd !== APP_ADMIN_PASSWORD) return false;
  store.set('mode', 'admin');
  if (welcomeWindow && !welcomeWindow.isDestroyed()) { welcomeWindow.destroy(); welcomeWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createAdminWindow();
  connectWs();
  return true;
});

ipcMain.handle('user:get-state', () => ({
  code: store.get('userCode'),
  roomName: currentRoomInfo.roomName,
  serverStatus: currentRoomInfo.serverStatus,
  wsState,
  volume: store.get('volume'),
  muted: store.get('muted'),
  disabled: store.get('disabled'),
  autoLaunch: store.get('autoLaunch'),
  overlayPosition: store.get('overlayPosition')
}));

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

ipcMain.handle('common:quit-app', () => {
  app.isQuiting = true;
  app.quit();
  return true;
});

ipcMain.handle('admin:get-state', () => ({
  serverUrl: store.get('serverUrl'),
  serverAdminPassword: store.get('serverAdminPassword'),
  overlayPosition: store.get('overlayPosition'),
  overlayDurationMs: store.get('overlayDurationMs'),
  autoLaunch: store.get('autoLaunch'),
  wsState
}));

ipcMain.handle('admin:save-local', (_e, data) => {
  if (typeof data.serverUrl === 'string') store.set('serverUrl', data.serverUrl.trim());
  if (typeof data.serverAdminPassword === 'string') store.set('serverAdminPassword', data.serverAdminPassword);
  if (typeof data.overlayPosition === 'string') store.set('overlayPosition', data.overlayPosition);
  if (data.overlayDurationMs) store.set('overlayDurationMs', Number(data.overlayDurationMs) || 8000);
  if (typeof data.autoLaunch === 'boolean') store.set('autoLaunch', data.autoLaunch);
  ensureAutoLaunch();
  if (tray) tray.setContextMenu(buildTrayMenu());
  connectWs();
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
      connectWs();
    }
  });

  app.on('window-all-closed', (e) => { e.preventDefault(); });
  app.on('before-quit', () => { closeWs(); });
}
