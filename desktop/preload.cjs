// 预加载脚本：只暴露一个受控的 API 给界面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiflow', {
  call: (channel, ...args) => ipcRenderer.invoke('api', channel, ...args),
  on: (channel, cb) => {
    const allowed = ['run:event', 'job:update', 'ui:request', 'ui:cancel', 'sched:changed', 'sched:log'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
  desktop: true,
});
