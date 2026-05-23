const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memedrop', {
  // Overlay
  onMeme: (cb) => ipcRenderer.on('meme:show', (_e, data) => cb(data)),

  // Welcome screen
  chooseMode: (mode) => ipcRenderer.invoke('welcome:choose', mode),

  // Admin panel
  getAdminState: () => ipcRenderer.invoke('admin:get-state'),
  saveLocal: (data) => ipcRenderer.invoke('admin:save-local', data),
  pushConfig: (data) => ipcRenderer.invoke('admin:push-config', data),
  serverStatus: () => ipcRenderer.invoke('admin:server-status'),
  broadcastTest: () => ipcRenderer.invoke('admin:broadcast-test'),
  testOverlayLocal: () => ipcRenderer.invoke('admin:test-overlay-local'),
  onWsStatus: (cb) => ipcRenderer.on('ws:status', (_e, data) => cb(data)),

  // Common
  openLink: (url) => ipcRenderer.invoke('common:open-link', url),
  backToWelcome: () => ipcRenderer.invoke('common:back-to-welcome')
});
