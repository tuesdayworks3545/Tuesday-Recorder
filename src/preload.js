const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tuesday', {
  playbackDevices: () => ipcRenderer.invoke('playback-list'),
  startPlayback: (id) => ipcRenderer.invoke('playback-start', id),
  stopPlayback: (id) => ipcRenderer.invoke('playback-stop', id),
  onPlayback: (callback) => { const listener=(_event,packet)=>callback(packet); ipcRenderer.on('playback-data',listener); return ()=>ipcRenderer.removeListener('playback-data',listener); },
  getDesktopSources: () => ipcRenderer.invoke('desktop-sources'),
  defaultRecordingFolder: () => ipcRenderer.invoke('default-recording-folder'),
  chooseRecordingFolder: (currentFolder) => ipcRenderer.invoke('choose-recording-folder', currentFolder),
  createRecovery: (options) => ipcRenderer.invoke('create-recovery', options),
  appendRecovery: (folder, id, bytes) => ipcRenderer.invoke('append-recovery', folder, id, bytes),
  finalizeRecovery: (folder, id) => ipcRenderer.invoke('finalize-recovery', folder, id),
  listRecoveries: (folder) => ipcRenderer.invoke('list-recoveries', folder),
  recoverRecording: (folder, id) => ipcRenderer.invoke('recover-recording', folder, id),
  discardRecovery: (folder, id) => ipcRenderer.invoke('discard-recovery', folder, id),
  saveMp3: (bytes, bitrate, naming, defaultFolder) => ipcRenderer.invoke('save-mp3', bytes, bitrate, naming, defaultFolder),
  showFile: (filePath) => ipcRenderer.invoke('show-file', filePath)
});
