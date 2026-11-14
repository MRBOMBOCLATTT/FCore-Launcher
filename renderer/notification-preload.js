const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pfcNotification', {
  onShow: (callback) => ipcRenderer.on('notification-data', (_event, data) => callback(data))
});
