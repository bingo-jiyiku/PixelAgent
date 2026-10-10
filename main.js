// ============================================================
// main.js —— Electron 主进程
// 职责：开窗口 + 把渲染层的"发消息"请求转给 pi-bridge，
//       再把 pi 吐出来的事件流转发回界面。
// ============================================================
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const bridge = require('./pi-bridge');

let win = null;          // 主窗口
let job = null;          // 当前正在跑的 pi 子进程（用来支持"停止"）
let sessionSeq = 0;      // 会话序号：点"新会话"就 +1，实现开新话题

// 会话文件都放在项目下的 .sessions/ 里（在 E 盘，不占 C 盘）
const SESSION_DIR = path.join(__dirname, '.sessions');

function sessionFile() {
  return path.join(SESSION_DIR, `chat-${sessionSeq}.json`);
}

function send(obj) {
  // 统一把消息发给界面；窗口关了就别发了
  if (win && !win.isDestroyed()) win.webContents.send('pi:msg', obj);
}

// 截图脚本用：等窗口建好后拿到它来截屏
function getWindow() { return win; }

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#f5f5f2',
    title: 'PixelAgent',
    // 不要系统原生标题栏/菜单栏：整个窗口就是一块画布，
    // 标题栏用页面里 HTML 做的假标题栏（win-title）代替，像素风统一。
    frame: false,
    autoHideMenuBar: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 默认直接进界面；设置了 PIXELAGENT_SHOT 就自动发一句话（截图脚本用）
  const shot = process.env.PIXELAGENT_SHOT;
  win.loadFile(path.join(__dirname, 'index.html'), shot ? { query: { auto: shot } } : {});
}

// 给测试/截图脚本复用
module.exports = { getWindow, sessionFile };

// ---------- 渲染层 -> 主进程：发一轮话 ----------
ipcMain.handle('pi:ask', (_e, text) => {
  if (job) return { ok: false, reason: 'BUSY' }; // 上一轮还没完，直接拒

  const loc = bridge.locate();
  send({ kind: 'boot', node: loc.node, cli: loc.cli, session: sessionFile() });

  job = bridge.ask({
    prompt: text,
    sessionFile: sessionFile(),
    onEvent(ev) {
      // 转发原始事件，界面自己认类型（text_delta / thinking / toolcall ...）
      send({ kind: 'ev', ev });
    },
    onState(state, detail) {
      send({ kind: 'state', state, detail });
    },
    onExit(info) {
      job = null;
      send({ kind: 'exit', code: info.code, error: info.error || '', stderr: (info.stderr || '').slice(-2000) });
    }
  });

  return { ok: true };
});

// ---------- 渲染层 -> 主进程：停止当前一轮 ----------
ipcMain.handle('pi:abort', () => {
  if (job) { job.abort(); job = null; return { ok: true }; }
  return { ok: false };
});

// ---------- 渲染层 -> 主进程：开新会话（清空上下文） ----------
ipcMain.handle('pi:new-session', () => {
  if (job) { job.abort(); job = null; }
  sessionSeq += 1;
  return { ok: true, session: sessionFile() };
});

// ---------- 渲染层 -> 主进程：看看 pi 装在哪、会话在哪（设置面板用） ----------
ipcMain.handle('pi:info', () => {
  const loc = bridge.locate();
  return {
    node: loc.node,
    cli: loc.cli,
    session: sessionFile(),
    sessionExists: fs.existsSync(sessionFile()),
    mode: 'json（换行分隔事件流）'
  };
});

// ---------- 窗口控制：最小化 / 最大化 / 关闭（无原生标题栏用） ----------
ipcMain.handle('win:min', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('win:max', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('win:close', () => { if (win && !win.isDestroyed()) win.close(); });

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    // macOS 点 Dock 图标时重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
