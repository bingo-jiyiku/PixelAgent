// ============================================================
// main.js —— Electron 主进程
// 职责：开窗口 + 把渲染层的请求转给 pi-bridge，
//       再把 pi 吐出来的事件流转发回界面；
//       顺带提供「会话列表 / 历史回放 / 文件树」三件真数据。
// ============================================================
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const bridge = require('./pi-bridge');

let win = null;          // 主窗口
let job = null;          // 当前正在跑的 pi 子进程（支持"停止"）
let sessionSeq = 0;      // 当前会话序号（对应 .sessions/chat-<n>.json）

// 会话文件放在项目下的 .sessions/（在 E 盘，不占 C 盘）
const SESSION_DIR = path.join(__dirname, '.sessions');
// 文件树根目录：pi 跑起来的工作目录
const WORK_DIR = __dirname;

function sessionFile(seq) {
  const n = (seq == null) ? sessionSeq : seq;
  return path.join(SESSION_DIR, `chat-${n}.json`);
}

function send(obj) {
  if (win && !win.isDestroyed()) win.webContents.send('pi:msg', obj);
}

function getWindow() { return win; }

// ============================================================
// 会话文件解析（pi 的会话是 NDJSON：一行一个条目）
// ============================================================
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n').trim();
  }
  return '';
}

function parseSession(file) {
  const out = { exists: false, cwd: '', model: '', msgs: [], title: '' };
  if (!fs.existsSync(file)) return out;
  out.exists = true;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    if (j.type === 'session' && j.cwd) out.cwd = j.cwd;
    if (j.type === 'model_change' && j.modelId) out.model = j.modelId;
    if (j.type === 'message' && j.message) {
      const role = j.message.role;
      const t = textOf(j.message.content);
      if (!t) continue;
      if (role === 'user') out.msgs.push({ role: 'user', text: t });
      else if (role === 'assistant') out.msgs.push({ role: 'assistant', text: t });
    }
  }
  const firstUser = out.msgs.find((m) => m.role === 'user');
  out.title = firstUser ? firstUser.text.replace(/\s+/g, ' ').slice(0, 42) : '(空会话)';
  return out;
}

function listSessionSeqs() {
  let names = [];
  try { names = fs.readdirSync(SESSION_DIR); } catch (e) { return []; }
  const seqs = [];
  for (const n of names) {
    const m = /^chat-(\d+)\.json$/.exec(n);
    if (m) seqs.push(Number(m[1]));
  }
  return seqs.sort((a, b) => a - b);
}

function listSessions() {
  const seqs = listSessionSeqs();
  const rows = seqs.map((seq) => {
    const file = sessionFile(seq);
    let st = null;
    try { st = fs.statSync(file); } catch (e) { /* ignore */ }
    const parsed = parseSession(file);
    const rounds = parsed.msgs.filter((m) => m.role === 'user').length;
    return {
      seq,
      file,
      mtime: st ? st.mtimeMs : 0,
      size: st ? st.size : 0,
      title: parsed.title,
      rounds,
      current: seq === sessionSeq
    };
  });
  rows.sort((a, b) => b.mtime - a.mtime);   // 最近改动的排前面
  return rows;
}

// ============================================================
// 文件树（只列一层，可点进子目录；限制在 WORK_DIR 之下）
// ============================================================
function listFiles(dir) {
  const base = path.resolve(WORK_DIR);
  let target = dir ? path.resolve(String(dir)) : base;
  // 防目录穿越：必须还在工作目录之下
  if (target !== base && !target.startsWith(base + path.sep)) target = base;

  let names = [];
  try { names = fs.readdirSync(target, { withFileTypes: true }); } catch (e) {
    return { root: base, dir: target, parent: null, items: [], error: e.message };
  }
  const items = [];
  for (const d of names) {
    // 噪音目录不进列表：文件树是给人看的，不是仓库镜像
    if (d.name === 'node_modules' || d.name === '.git') continue;
    const full = path.join(target, d.name);
    let size = 0;
    try { if (d.isFile()) size = fs.statSync(full).size; } catch (e) { /* ignore */ }
    items.push({ name: d.name, dir: d.isDirectory(), size, path: full });
  }
  // 目录优先，然后按名字
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
  return { root: base, dir: target, parent: target !== base ? path.dirname(target) : null, items };
}

// ============================================================
// 窗口
// ============================================================
function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 1024,
    minHeight: 660,
    backgroundColor: '#ffffff',
    title: 'PixelAgent',
    // 无原生标题栏：整个窗口一块画布，标题栏用页面里 HTML 自绘
    frame: false,
    autoHideMenuBar: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const shot = process.env.PIXELAGENT_SHOT;
  win.loadFile(path.join(__dirname, 'index.html'), shot ? { query: { auto: shot } } : {});
}

module.exports = { getWindow, sessionFile };

// ---------- 渲染层 -> 主进程：发一轮话 ----------
ipcMain.handle('pi:ask', (_e, text) => {
  if (job) return { ok: false, reason: 'BUSY' };

  const loc = bridge.locate();
  send({ kind: 'boot', node: loc.node, cli: loc.cli, session: sessionFile() });

  job = bridge.ask({
    prompt: text,
    sessionFile: sessionFile(),
    cwd: WORK_DIR,
    onEvent(ev) { send({ kind: 'ev', ev }); },
    onState(state, detail) { send({ kind: 'state', state, detail }); },
    onExit(info) {
      job = null;
      send({
        kind: 'exit', code: info.code, error: info.error || '',
        stderr: (info.stderr || '').slice(-2000)
      });
    }
  });

  return { ok: true };
});

// ---------- 停止当前这一轮 ----------
ipcMain.handle('pi:abort', () => {
  if (job) { job.abort(); job = null; return { ok: true }; }
  return { ok: false };
});

// ---------- 新会话（序号取最大值 +1，不覆盖已有） ----------
ipcMain.handle('pi:new-session', () => {
  if (job) { job.abort(); job = null; }
  const seqs = listSessionSeqs();
  sessionSeq = seqs.length ? Math.max(...seqs) + 1 : 0;
  return { ok: true, seq: sessionSeq, session: sessionFile() };
});

// ---------- 会话列表 ----------
ipcMain.handle('pi:sessions', () => ({ ok: true, sessions: listSessions(), current: sessionSeq }));

// ---------- 打开（切换）某个历史会话 ----------
ipcMain.handle('pi:open-session', (_e, seq) => {
  const n = Number(seq);
  if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'BAD_SEQ' };
  if (job) { job.abort(); job = null; }
  sessionSeq = n;
  return { ok: true, seq: sessionSeq, session: sessionFile() };
});

// ---------- 回放某个会话的历史消息 ----------
ipcMain.handle('pi:session-history', (_e, seq) => {
  const n = (seq == null) ? sessionSeq : Number(seq);
  const parsed = parseSession(sessionFile(n));
  return { ok: true, seq: n, cwd: parsed.cwd, model: parsed.model, msgs: parsed.msgs };
});

// ---------- 文件树 ----------
ipcMain.handle('pi:files', (_e, dir) => listFiles(dir));

// ---------- 设置面板信息 ----------
ipcMain.handle('pi:info', () => {
  const loc = bridge.locate();
  return {
    node: loc.node,
    cli: loc.cli,
    session: sessionFile(),
    sessionExists: fs.existsSync(sessionFile()),
    cwd: WORK_DIR,
    mode: 'json（换行分隔事件流）'
  };
});

// ---------- 窗口控制（无原生标题栏用） ----------
ipcMain.handle('win:min', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('win:max', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('win:close', () => { if (win && !win.isDestroyed()) win.close(); });

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
