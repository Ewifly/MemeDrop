const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const WebSocket = require('ws');

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
    autoLaunch: true
  }
});

const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');

let tray = null;
let welcomeWindow = null;
let adminWindow = null;
let overlayWindow = null;
let ws = null;
let wsReconnectTimer = null;
let wsState = 'idle';

// --- helpers ---

function getTrayIcon() {
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
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
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
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
  if (!overlayWindow) createOverlayWindow();
  positionOverlay(store.get('overlayPosition'));
  const duration = store.get('overlayDurationMs');

  const send = () => {
    overlayWindow.webContents.send('meme:show', {
      mediaUrl: mediaUrl || null,
      mediaKind: mediaKind || null,
      text: text || '',
      duration
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
  if (welcomeWindow) { welcomeWindow.focus(); return; }
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
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function createAdminWindow() {
  if (adminWindow) { adminWindow.focus(); return; }
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
  adminWindow.on('closed', () => { adminWindow = null; });
}

// --- Tray ---

function buildTrayMenu() {
  const mode = store.get('mode');
  const items = [
    { label: `MemeDrop (${mode || 'non configure'})`, enabled: false },
    { type: 'separator' },
    {
      label: 'Test overlay (local)',
      click: () => showMeme({ text: 'Test MemeDrop !', mediaUrl: null, mediaKind: null })
    }
  ];

  if (mode === 'admin') {
    items.push({ label: 'Panneau admin', click: () => createAdminWindow() });
  }
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

function goBackToWelcome() {
  store.set('mode', null);
  closeWs();
  if (adminWindow) { adminWindow.close(); adminWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createWelcomeWindow();
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('MemeDrop');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => {
    const mode = store.get('mode');
    if (mode === 'admin') createAdminWindow();
    else if (!mode) createWelcomeWindow();
  });
}

// --- IPC ---

ipcMain.handle('welcome:choose-user', (_e, code) => {
  const c = String(code || '').trim();
  if (!c) return false;
  store.set('mode', 'user');
  store.set('userCode', c);
  if (welcomeWindow) { welcomeWindow.close(); welcomeWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  connectWs();
  return true;
});

ipcMain.handle('welcome:choose-admin', (_e, pwd) => {
  if (pwd !== APP_ADMIN_PASSWORD) return false;
  store.set('mode', 'admin');
  if (welcomeWindow) { welcomeWindow.close(); welcomeWindow = null; }
  if (tray) tray.setContextMenu(buildTrayMenu());
  createAdminWindow();
  connectWs();
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

// --- bootstrap ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mode = store.get('mode');
    if (mode === 'admin') createAdminWindow();
    else if (!mode) createWelcomeWindow();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.memedrop.app');
    createTray();
    createOverlayWindow();
    ensureAutoLaunch();

    const mode = store.get('mode');
    if (!mode) {
      createWelcomeWindow();
    } else {
      if (mode === 'admin' && !process.argv.includes('--hidden')) {
        createAdminWindow();
      }
      connectWs();
    }
  });

  app.on('window-all-closed', (e) => { e.preventDefault(); });
  app.on('before-quit', () => { closeWs(); });
}
