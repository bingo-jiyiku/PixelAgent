/* ============================================================
   renderer.js —— 界面逻辑（纯浏览器 JS，不碰 Node）
   干这些事：
   1) 把用户输入发给主进程 -> pi，把事件流画成打字机 + 工具行
   2) 左栏：会话列表（真读 .sessions/），点一条回放历史
   3) 右栏：TOOLS / TODOS / FILES / AGENTS 四个 tab
   4) 底部状态栏：状态灯 / 轮次 / 用时 / 模型 / 时钟
   ============================================================ */
'use strict';

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const log = $('log');
const welcome = $('welcome');
const input = $('input');
const mirror = $('mirror');
const cursor = $('cursor');
const btnSend = $('btn-send');
const btnStop = $('btn-stop');
const mask = $('mask');

const api = window.pixelAPI || null;   // 浏览器直开时没有它 -> 演示模式

/* ---------- 运行状态 ---------- */
const S = {
  busy: false,
  round: 0,
  startedAt: 0,
  timer: null,
  thinkEl: null,
  bubble: null,
  toolEl: null,
  lastState: 'IDLE',
  seq: 0,          // 当前会话序号
  tools: [],       // 本会话工具调用记录（右栏 TOOLS）
  fileDir: '',     // 当前文件树目录
  fileCache: []    // 工作目录条目缓存（@ 引用补全用）
};
window.__pixel = S;   // 截图脚本读这个

/* ============================================================
   小工具
   ============================================================ */
function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}
function fmtClock(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 工具参数 / 结果取摘要（pi 的事件结构：args 是对象，result.content 是文本块数组）
function briefOf(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args);
  const pick = args.command || args.path || args.file || args.pattern || args.query;
  return String(pick != null ? pick : JSON.stringify(args)).slice(0, 120);
}
function extractText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) {
    return res.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
  }
  if (typeof res.output === 'string') return res.output;
  if (typeof res.text === 'string') return res.text;
  return '';
}

/* ============================================================
   消息时间线
   ============================================================ */
function showTimeline() {
  if (welcome) welcome.classList.add('hidden');
}
function addMsg(cls, who, txt) {
  showTimeline();
  const m = el('div', 'm ' + cls);
  m.appendChild(el('span', 'who', who));
  if (txt != null) m.appendChild(el('span', 'txt', txt));
  log.appendChild(m);
  scrollEnd();
  return m;
}
function scrollEnd() { log.scrollTop = log.scrollHeight; }

/* ---------- 状态灯 + 像素女孩状态联动 ---------- */
function setState(state) {
  S.lastState = state;
  const tag = $('sb-state');
  if (tag) {
    tag.textContent = state;
    tag.dataset.status = state;
    tag.classList.toggle('on', state !== 'IDLE');
  }
  const girl = $('pixel-girl');
  const scene = $('girl-scene');
  const cap = $('girl-cap');
  if (girl) girl.dataset.state = state;
  if (scene) scene.dataset.state = state;
  if (cap) {
    cap.textContent =
      state === 'THINKING' ? 'THINKING…' :
      state === 'TOOL' ? 'WORKING…' :
      state === 'DONE' ? 'DONE!' :
      state === 'IDLE' ? 'STANDBY' : state;
  }
}

/* ---------- 计时 ---------- */
function startTimer() {
  S.startedAt = Date.now();
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    $('kv-time').textContent = ((Date.now() - S.startedAt) / 1000).toFixed(1) + 's';
  }, 100);
}
function stopTimer() { clearInterval(S.timer); S.timer = null; }

/* ---------- 输入行的方块光标 ---------- */
function syncCursor() {
  mirror.textContent = input.value;
  const w = Math.min(mirror.offsetWidth, input.clientWidth - 12);
  cursor.style.left = (16 + w) + 'px';
}
input.addEventListener('input', () => { syncCursor(); updatePalette(); });
input.addEventListener('focus', () => { cursor.style.background = '#a8669c'; });
input.addEventListener('blur', () => { cursor.style.background = '#5c5348'; });

/* ---------- 打字机尾部光标 ---------- */
function addCaret() {
  if (!S.bubble || S.bubble.querySelector('.stream-caret')) return;
  const c = document.createElement('span');
  c.className = 'stream-caret';
  S.bubble.appendChild(c);
}
function removeCaret() {
  if (!S.bubble) return;
  const c = S.bubble.querySelector('.stream-caret');
  if (c) c.remove();
}

/* ============================================================
   发送
   ============================================================ */
function send() {
  const text = input.value.trim();
  if (!text) return;
  if (S.busy) { addMsg('err', 'ERR', '上一轮还没结束，先按 ESC 停掉它。'); return; }

  input.value = '';
  syncCursor();
  S.round += 1;
  $('kv-round').textContent = String(S.round);
  S.busy = true;
  btnStop.classList.remove('hidden');
  setState('THINKING');
  startTimer();
  addMsg('user', 'YOU', esc(text));

  if (!api) { demoReply(text); return; }

  api.ask(text).then((r) => {
    if (r && r.ok === false) {
      addMsg('err', 'ERR', '主进程拒绝了这次请求：' + (r.reason || '未知'));
      endTurn(-1);
    }
  }).catch((e) => {
    addMsg('err', 'ERR', '发送失败：' + (e && e.message ? e.message : e));
    endTurn(-1);
  });
}

function endTurn(code) {
  S.busy = false;
  stopTimer();
  btnStop.classList.add('hidden');
  removeCaret();
  setState('DONE');
  if (code !== 0 && code != null) {
    addMsg('err', 'ERR', 'pi 退出码 ' + code + '（看看是不是没认证）');
  }
  refreshSessions();   // 会话文件变了，左栏跟着更新
}

function doAbort() {
  if (!S.busy) return;
  if (api) api.abort();
  addMsg('step', 'STOP', '&gt; 已手动停止这一轮');
  endTurn(0);
}

/* ============================================================
   处理 pi 的事件流
   ============================================================ */
function onMsg(msg) {
  if (!msg) return;

  if (msg.kind === 'boot') {
    $('set-cli').textContent = msg.cli || '未找到';
    $('set-session').textContent = msg.session || '—';
    return;
  }
  if (msg.kind === 'state') return;
  if (msg.kind === 'exit') {
    if (msg.error) addMsg('err', 'ERR', esc(msg.error));
    endTurn(msg.code);
    return;
  }
  if (msg.kind !== 'ev') return;

  const ev = msg.ev;
  if (!ev || !ev.type) return;

  if (ev.type === 'message_update' && ev.assistantMessageEvent) {
    const a = ev.assistantMessageEvent;
    switch (a.type) {
      case 'thinking_start':
        setState('THINKING');
        S.thinkEl = addMsg('think', '...', '思考中<span class="dots"><i></i><i></i><i></i></span> <span class="tk"></span>');
        break;
      case 'thinking_delta': {
        const t = S.thinkEl && S.thinkEl.querySelector('.tk');
        if (t) {
          const now = (t.dataset.full || '') + (a.delta || '');
          t.dataset.full = now;
          t.textContent = now.replace(/\s+/g, ' ').slice(-70);
          t.style.color = '#999';
        }
        break;
      }
      case 'thinking_end':
        if (S.thinkEl) {
          const d = S.thinkEl.querySelector('.dots');
          if (d) d.remove();
        }
        break;
      case 'text_start': {
        setState('THINKING');
        S.bubble = el('span', 'bubble', '');
        const m = el('div', 'm bot');
        m.appendChild(el('span', 'who', 'PI'));
        m.appendChild(S.bubble);
        log.appendChild(m);
        showTimeline();
        scrollEnd();
        break;
      }
      case 'text_delta':
        if (S.bubble) {
          addCaret();
          S.bubble.textContent += a.delta || '';
          addCaret();
          scrollEnd();
        }
        break;
      case 'text_end':
        removeCaret();
        break;
      case 'toolcall_start':
        setState('TOOL');
        S.toolEl = addMsg('tool', 'TOOL', '&gt; 调用工具: ' + esc(a.toolName || '?') + ' …');
        break;
      case 'toolcall_end': {
        // 界面上那行「调用工具 X」的实时反馈（右栏记录走 tool_execution_end，那里有真结果）
        const tc = a.toolCall || {};
        const args = tc.arguments || {};
        const name = tc.name || a.toolName || '?';
        if (S.toolEl) {
          S.toolEl.querySelector('.txt').innerHTML =
            '&gt; 调用工具: ' + esc(name) + ' ' + esc(briefOf(args).slice(0, 90));
          scrollEnd();
        }
        break;
      }
      default: break;
    }
    return;
  }

  if (ev.type === 'turn_end' && ev.message) {
    if (ev.message.model) {
      $('kv-model').textContent = ev.message.model;
      $('kv-model2').textContent = ev.message.model;
      $('set-model').textContent = (ev.message.provider || '') + '/' + ev.message.model;
    }
    return;
  }
  if (ev.type === 'agent_settled') { endTurn(0); return; }
  if (ev.type === 'error') {
    addMsg('err', 'ERR', esc(ev.message || JSON.stringify(ev).slice(0, 200)));
    return;
  }
  // 工具真实执行结束：右栏 TOOLS 记一条（含入参 + 真实输出摘要）
  // 字段结构取自真实抓包：{toolName, args, result:{content:[{type:'text',text}]}}
  if (ev.type === 'tool_execution_end') {
    pushTool(ev.toolName || '?', briefOf(ev.args), extractText(ev.result));
  }
}
// 验收/调试入口：可以把真实事件流直接喂进来重跑一遍渲染（test/verify-tools.js 用）
window.__pixelFeed = onMsg;

if (api) api.onMsg(onMsg);

/* ============================================================
   左栏：会话列表
   ============================================================ */
function renderSessions(rows) {
  const box = $('session-list');
  box.innerHTML = '';
  if (!rows || !rows.length) {
    box.appendChild(el('div', 'sess',
      '<span class="sess-idx">--</span><span class="sess-main">' +
      '<span class="sess-name">还没有会话</span>' +
      '<span class="sess-meta">点右上 + NEW 开一个</span></span>'));
    return;
  }
  rows.forEach((r) => {
    const d = el('div', 'sess' + (r.current ? ' on' : ''));
    d.innerHTML =
      '<span class="sess-idx">#' + r.seq + '</span>' +
      '<span class="sess-main">' +
        '<span class="sess-name">' + esc(r.title) + '</span>' +
        '<span class="sess-meta">' + r.rounds + ' 轮 · ' + fmtClock(r.mtime) + '</span>' +
      '</span>';
    d.title = r.file;
    d.addEventListener('click', () => openSession(r.seq));
    box.appendChild(d);
  });
}

function updateCur(seq) {
  const e = $('tb-cur');
  if (e) e.textContent = 'SESSION #' + seq;
}

async function refreshSessions() {
  if (!api) { renderSessions([]); updateCur(S.seq); return; }
  try {
    const r = await api.sessions();
    if (r && typeof r.current === 'number') S.seq = r.current;
    updateCur(S.seq);
    renderSessions(r.sessions || []);
  } catch (e) { /* 静默：列表刷不出来不该打断主流程 */ }
}

async function openSession(seq) {
  if (!api) return;
  if (S.busy) doAbort();
  const r = await api.openSession(seq);
  if (!r || r.ok === false) return;
  S.seq = r.seq;
  S.tools = [];
  renderTools();
  log.innerHTML = '';
  const h = await api.history(seq);
  if (!h || !h.msgs || !h.msgs.length) {
    addMsg('sys', 'SYS', '空会话。在下面输入开始对话。');
  } else {
    h.msgs.forEach((m) => {
      if (m.role === 'user') addMsg('user', 'YOU', esc(m.text));
      else addMsg('bot', 'PI', esc(m.text));
    });
    S.round = h.msgs.filter((m) => m.role === 'user').length;
    $('kv-round').textContent = String(S.round);
    if (h.model) { $('kv-model').textContent = h.model; $('kv-model2').textContent = h.model; }
    addMsg('step', 'SYS', '&gt; 已切到会话 #' + seq + '（上下文延续）');
  }
  setState('IDLE');
  refreshSessions();
}

async function newSession() {
  if (!api) { doNewSessionLocal(); return; }
  if (S.busy) doAbort();
  const r = await api.newSession();
  if (!r || r.ok === false) return;
  S.seq = r.seq;
  S.tools = [];
  renderTools();
  doNewSessionLocal();
  refreshSessions();
}
function doNewSessionLocal() {
  log.innerHTML = '';
  S.round = 0;
  $('kv-round').textContent = '0';
  $('kv-model').textContent = '—';
  $('kv-model2').textContent = '—';
  setState('IDLE');
  if (welcome) welcome.classList.remove('hidden');
  input.focus();
}

/* ============================================================
   右栏：tab 切换 + TOOLS + FILES
   ============================================================ */
document.querySelectorAll('.rtab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    ['tools', 'todos', 'files', 'sub'].forEach((t) => {
      $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
    });
    if (b.dataset.tab === 'files') loadFiles(S.fileDir || undefined);   // 每次点开都刷一次最新
  });
});

function renderTools() {
  const box = $('tools-list');
  const empty = $('tools-empty');
  box.innerHTML = '';
  if (!S.tools.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  S.tools.forEach((t, i) => {
    const d = el('div', 'tool-item');
    const out = t.out
      ? '<span class="t-out">' + esc(t.out.replace(/\s+/g, ' ').trim().slice(0, 180)) + '</span>'
      : '';
    d.innerHTML =
      '<span class="t-name">' + esc(t.name) + '</span>' +
      '<span class="t-arg"><span class="t-n">#' + (i + 1) + '</span>' + esc(t.arg || '') + '</span>' +
      out;
    box.appendChild(d);
  });
}
function pushTool(name, arg, out) {
  S.tools.push({ name, arg, out: out || '' });
  renderTools();
}

async function loadFiles(dir) {
  if (!api) {
    $('files-root').textContent = '(演示模式无文件树)';
    return;
  }
  const r = await api.files(dir);
  S.fileDir = r.dir;
  S.fileCache = r.items || [];
  $('files-root').textContent = r.dir;
  const box = $('files-list');
  box.innerHTML = '';
  if (r.parent) {
    const up = el('div', 'file-item dir');
    up.innerHTML = '<span class="f-ico">DIR</span><span class="f-n">..</span>';
    up.addEventListener('click', () => loadFiles(r.parent));
    box.appendChild(up);
  }
  (r.items || []).forEach((it) => {
    const d = el('div', 'file-item' + (it.dir ? ' dir' : ''));
    d.innerHTML =
      '<span class="f-ico">' + (it.dir ? 'DIR' : 'FIL') + '</span>' +
      '<span class="f-n">' + esc(it.name) + '</span>' +
      '<span class="f-s">' + (it.dir ? '' : fmtBytes(it.size)) + '</span>';
    if (it.dir) d.addEventListener('click', () => loadFiles(it.path));
    box.appendChild(d);
  });
}
if ($('btn-refresh-files')) $('btn-refresh-files').addEventListener('click', () => loadFiles(S.fileDir));

/* ============================================================
   命令面板（/ 开头）+ 文件引用（@ 开头）
   这是「操作像 opencode」的部分：/ 选命令，@ 引用文件
   ============================================================ */
function switchTab(t) {
  const b = document.querySelector('.rtab[data-tab="' + t + '"]');
  if (b) b.click();
}

const COMMANDS = [
  { k: '/new',   d: '新建会话（清空上下文）',        run: () => newSession() },
  { k: '/stop',  d: '停止当前这一轮',                run: () => doAbort() },
  { k: '/tools', d: '打开右栏 TOOLS',                run: () => switchTab('tools') },
  { k: '/files', d: '打开右栏 FILES',                run: () => switchTab('files') },
  { k: '/clear', d: '清空当前视图（不动会话文件）',   run: () => { log.innerHTML = ''; if (welcome) welcome.classList.remove('hidden'); } },
  { k: '/info',  d: '查看后端 / 会话信息',            run: () => $('btn-settings').click() }
];

const pal = { open: false, mode: '', items: [], idx: 0 };

function openPalette(mode, hd) {
  pal.open = true;
  pal.mode = mode;
  $('pal-hd').textContent = hd;
  $('palette').classList.remove('hidden');
}
function closePalette() {
  if (!pal.open) return;
  pal.open = false;
  $('palette').classList.add('hidden');
}
function renderPalette() {
  const box = $('pal-list');
  box.innerHTML = '';
  pal.items.forEach((it, i) => {
    const d = el('div', 'pal-item' + (i === pal.idx ? ' on' : ''));
    d.innerHTML = '<span class="pal-k">' + esc(it.label) + '</span>' +
                  '<span class="pal-d">' + esc(it.desc || '') + '</span>';
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const item = pal.items[i];
      closePalette();
      if (pal.mode === 'cmd') { input.value = ''; syncCursor(); }
      if (item && item.run) item.run();
    });
    box.appendChild(d);
  });
}

function updatePalette() {
  const v = input.value;

  // --- / 命令模式：整行必须以 / 开头 ---
  if (v.startsWith('/')) {
    const q = v.slice(1).toLowerCase();
    pal.items = COMMANDS
      .filter((c) => c.k.slice(1).toLowerCase().includes(q) || c.d.includes(v.slice(1)))
      .map((c) => ({ label: c.k, desc: c.d, run: c.run }));
    if (pal.items.length) { if (!pal.open || pal.mode !== 'cmd') pal.idx = 0; openPalette('cmd', 'COMMANDS'); renderPalette(); }
    else closePalette();
    return;
  }

  // --- @ 文件引用模式：光标前最后一个 @ 后面还没打空格 ---
  const at = v.lastIndexOf('@');
  if (at >= 0 && !/\s/.test(v.slice(at + 1))) {
    const q = v.slice(at + 1).toLowerCase();
    pal.items = S.fileCache
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({
        label: '@' + f.name,
        desc: (f.dir ? '目录' : (fmtBytes(f.size) || '文件')) + ' · ' + (S.fileDir || '工作目录'),
        run: () => { input.value = v.slice(0, at) + '@' + f.name + ' '; syncCursor(); input.focus(); }
      }));
    if (pal.items.length) { if (!pal.open || pal.mode !== 'file') pal.idx = 0; openPalette('file', 'REFERENCE'); renderPalette(); }
    else closePalette();
    return;
  }

  closePalette();
}

/* ============================================================
   按钮 / 键盘
   ============================================================ */
btnSend.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  // 面板开着时：上下选、回车上屏、ESC 只关面板
  if (pal.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); pal.idx = (pal.idx + 1) % pal.items.length; renderPalette(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); pal.idx = (pal.idx - 1 + pal.items.length) % pal.items.length; renderPalette(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const it = pal.items[pal.idx];
      const wasCmd = pal.mode === 'cmd';
      closePalette();
      if (wasCmd) { input.value = ''; syncCursor(); }
      if (it && it.run) it.run();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  }
  if (e.key === 'Enter') { e.preventDefault(); send(); }
  if (e.key === 'Escape') { e.preventDefault(); doAbort(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== input) doAbort();
  // Ctrl+N 新会话（opencode 手感）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
});
// 点到别处就把面板收起来
document.addEventListener('mousedown', (e) => {
  if (!pal.open) return;
  if (e.target === input || (e.target.closest && e.target.closest('#palette'))) return;
  closePalette();
});
btnStop.addEventListener('click', doAbort);
$('btn-new').addEventListener('click', newSession);

/* 设置面板 */
$('btn-settings').addEventListener('click', () => {
  mask.classList.remove('hidden');
  if (api) api.info().then((i) => {
    $('set-cli').textContent = i.cli || '未找到 pi 入口';
    $('set-session').textContent = i.session;
    $('set-mode').textContent = i.mode;
    $('kv-cwd').textContent = i.cwd || '—';
    $('kv-cwd').title = i.cwd || '';
    $('kv-model2').textContent = $('kv-model').textContent;
    if (i.cli === null) $('set-model').textContent = 'pi 未安装';
  });
});
$('dlg-close').addEventListener('click', () => mask.classList.add('hidden'));
$('dlg-x').addEventListener('click', () => mask.classList.add('hidden'));
mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.add('hidden'); });

/* 窗口按钮 */
$('tb-min').addEventListener('click', () => api && api.winMin());
$('tb-max').addEventListener('click', () => api && api.winMax());
$('tb-close').addEventListener('click', () => api && api.winClose());
$('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('.tb-btn')) return;
  api && api.winMax();
});

/* ============================================================
   时钟
   ============================================================ */
function tick() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  $('sb-clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tick, 1000); tick();

/* ============================================================
   演示模式：没有 pixelAPI 时自己演一段
   ============================================================ */
function demoReply(text) {
  S.bubble = null;
  setState('THINKING');
  setTimeout(() => {
    S.thinkEl = addMsg('think', '...', '思考中<span class="dots"><i></i><i></i><i></i></span>');
  }, 300);
  setTimeout(() => {
    if (S.thinkEl) S.thinkEl.querySelector('.dots').remove();
    const m = el('div', 'm bot');
    m.appendChild(el('span', 'who', 'PI'));
    S.bubble = el('span', 'bubble', '');
    m.appendChild(S.bubble);
    log.appendChild(m);
    const reply = '（演示模式）收到：' + text + '\n真实运行时这段话会由 pi 逐字流进来。';
    let i = 0;
    const t = setInterval(() => {
      if (!S.bubble) return clearInterval(t);
      addCaret();
      S.bubble.textContent += reply[i++] || '';
      addCaret();
      scrollEnd();
      if (i >= reply.length) { clearInterval(t); endTurn(0); }
    }, 30);
  }, 1100);
}

/* ============================================================
   启动
   ============================================================ */
syncCursor();
setState('IDLE');
setTimeout(() => input.focus(), 120);
refreshSessions();
if (api) {
  api.info().then((i) => {
    if (i && i.cwd) { $('kv-cwd').textContent = i.cwd; $('kv-cwd').title = i.cwd; }
  });
  // 预取一次工作目录条目，@ 引用才能一打就出候选
  api.files().then((r) => {
    if (r && r.items) { S.fileCache = r.items; S.fileDir = r.dir; }
  }).catch(() => {});
}

const q = new URLSearchParams(location.search);
if (q.get('auto')) {
  // 截图脚本用：延迟 3 秒再自动发，好让脚本先拍到干净的待机界面
  setTimeout(() => { input.value = q.get('auto'); syncCursor(); send(); }, 3000);
}
