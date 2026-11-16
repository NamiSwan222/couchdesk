const { contextBridge, ipcRenderer: ipc } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  info: () => ipc.invoke('info'),
  version: () => ipc.invoke('version'),
  checkUpdate: () => ipc.invoke('update:check'),
  installUpdate: () => ipc.send('update:install'),
  onUpdate: (fn) => ipc.on('update', (_e, d) => fn(d)),
  hostStart: () => ipc.invoke('host:start'),
  hostStop: () => ipc.invoke('host:stop'),
  newPin: () => ipc.invoke('host:newpin'),
  copy: (t) => ipc.invoke('copy', t),
  hostSend: (sid, msg) => ipc.send('host:send', { sid, msg }),
  hostKick: (sid) => ipc.send('host:kick', sid),
  sendInput: (ev) => ipc.send('input', ev),
  onSignal: (fn) => ipc.on('host:signal', (_e, d) => fn(d)),
  onViewer: (fn) => ipc.on('host:viewer', (_e, d) => fn(d)),
  onHostError: (fn) => ipc.on('host:error', (_e, d) => fn(d)),
});
