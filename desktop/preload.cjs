const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('personalMedia', {
  chooseFolder: (kind) => ipcRenderer.invoke('setup:choose-folder', kind),
  loadSettings: () => ipcRenderer.invoke('setup:load'),
  saveSettings: (settings) => ipcRenderer.invoke('setup:save', settings)
});
