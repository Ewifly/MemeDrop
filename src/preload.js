const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memedrop', {
  // Overlay
  onMeme: (cb) => ipcRenderer.on('meme:show', (_e, data) => cb(data)),

  // Welcome screen
  chooseUser: (code) => ipcRenderer.invoke('welcome:choose-user', code),
  chooseAdmin: (pwd) => ipcRenderer.invoke('welcome:choose-admin', pwd),

  // Admin panel
  getAdminState: () => ipcRenderer.invoke('admin:get-state'),
  saveLocal: (data) => ipcRenderer.invoke('admin:save-local', data),
  pushToken: (token) => ipcRenderer.invoke('admin:push-token', token),
  addRoom: (room) => ipcRenderer.invoke('admin:add-room', room),
  deleteRoom: (code) => ipcRenderer.invoke('admin:delete-room', code),
  serverStatus: () => ipcRenderer.invoke('admin:server-status'),
  broadcastTest: (code) => ipcRenderer.invoke('admin:broadcast-test', code),
  testOverlayLocal: () => ipcRenderer.invoke('admin:test-overlay-local'),
  onWsStatus: (cb) => ipcRenderer.on('ws:status', (_e, data) => cb(data)),

  // Common
  openLink: (url) => ipcRenderer.invoke('common:open-link', url),
  backToWelcome: () => ipcRenderer.invoke('common:back-to-welcome')
});
