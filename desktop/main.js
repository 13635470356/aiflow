// Electron 主进程：窗口、托盘、开机启动、通知；业务全部在 api.js
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, 'icon.png');
let win, tray, quitting = false;

// 只允许一个 aiflow 桌面版运行（避免定时任务被执行两次）
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => showWindow());

const notify = (body) => { if (Notification.isSupported()) new Notification({ title: 'aiflow', body, icon: ICON }).show(); };

const api = createApi({
  owner: 'desktop',
  send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); updateTray(); },
  platform: {
    desktop: true,
    async pickFolder() {
      const r = await dialog.showOpenDialog(win, { title: '选择项目文件夹', properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    async pickFiles() {
      const r = await dialog.showOpenDialog(win, {
        title: '添加需求素材', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '需求素材', extensions: ['md', 'txt', 'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html'] }, { name: '所有文件', extensions: ['*'] }],
      });
      return r.canceled ? [] : r.filePaths;
    },
    async pickFile({ title, cwd }) {
      const r = await dialog.showOpenDialog(win, { title, defaultPath: cwd, properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0];
    },
    attention(kind, p) {
      if (win && win.isVisible() && win.isFocused()) return;
      win?.flashFrame(true);
      const who = p?.project ? `[${p.project}] ` : '';
      const body = { approve: '有内容等你拍板', answer: `${p?.tool ?? '子 agent'} 有问题要问你`, confirm: '需要你确认', choose: '需要你选择', interactive: `已打开 ${p?.name ?? ''} 窗口，请去对话` }[kind];
      if (body) notify(who + body);
    },
    notifyDone(job) {
      if (win && win.isVisible() && win.isFocused()) return;
      notify(`[${job.project}] ${job.scheduleName ? `定时任务"${job.scheduleName}"` : '任务'}${job.status === 'done' ? '已完成' : `失败：${job.error || ''}`}`);
    },
    setOpenAtLogin(on) { app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }); },
    openPath: (p) => shell.openPath(p),
    showItem: (p) => shell.showItemInFolder(p),
  },
});

ipcMain.handle('api', (_e, channel, ...args) => api.call(channel, ...args));

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function updateTray() {
  if (!tray) return;
  const n = api.runningCount();
  tray.setToolTip(n ? `aiflow · ${n} 个任务运行中` : 'aiflow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 aiflow', click: showWindow },
    { label: n ? `${n} 个任务运行中` : '没有运行中的任务', enabled: false },
    { type: 'separator' },
    { label: '退出（会停止所有任务和定时调度）', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createWindow({ hidden = false } = {}) {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1040, minHeight: 660,
    title: 'aiflow', icon: ICON, show: !hidden,
    backgroundColor: '#f4f5f7', autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (quitting) return;
    const cfg = loadConfig();
    // 有定时任务或任务在跑时，默认关到托盘继续运行
    if (cfg.trayOnClose !== false && (api.hasSchedules() || api.isRunning())) {
      e.preventDefault();
      win.hide();
      if (!app.__trayHintShown) { notify('aiflow 已最小化到托盘，定时任务和运行中的任务会继续执行'); app.__trayHintShown = true; }
      return;
    }
    if (api.isRunning()) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['停止并退出', '取消'], defaultId: 1, cancelId: 1, title: 'aiflow', message: '还有任务在运行，确定要退出吗？' });
      if (r === 1) { e.preventDefault(); return; }
    }
    quitting = true;
    app.quit();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadFile(path.join(here, 'renderer', 'index.html'));
}

Menu.setApplicationMenu(null);
app.setAppUserModelId('dev.aiflow.desktop');
app.whenReady().then(() => {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  updateTray();
  createWindow({ hidden: process.argv.includes('--hidden') });
});
app.on('before-quit', () => { quitting = true; api.stop(); api.shutdown(); });
app.on('window-all-closed', () => { /* 托盘常驻，由托盘菜单退出 */ });
