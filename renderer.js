/* ============================================================
   renderer.js —— 界面逻辑（纯浏览器 JS，不碰 Node）
   1) 消息时间线：流式打字机 + Markdown 渲染 + 消息级操作（复制/重发）
   2) 左栏：会话列表（真读 .sessions/），点一条回放历史
   3) 右栏：TOOLS（可展开完整入参/输出）/ TODOS / FILES / AGENTS
   4) 底部：prompt + / 命令面板 + @ 文件引用 + 状态栏（用量条/模型/思考档位）
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
  seq: 0,
  tools: [],
  fileDir: '',
  fileCache: [],
  lastUser: '',       // 上一条用户输入（RETRY 用）
  models: [],         // 模型目录（真跑 pi --list-models 拿到）
  curModel: null,     // {provider, model} | null = 用 pi 默认
  curThinking: null,  // off..max | null = 用 pi 默认
  modelsLoaded: false,
  pendingTool: {}     // toolCallId -> {name, args}：args 只在 start 事件里有
};
window.__pixel = S;   // 截图/验收脚本读这个

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
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1048576) return (n / 1048576).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function fmtClock(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
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

/* ---------- 剪贴板（file:// 下 clipboard API 不一定可用，兜底 execCommand） ---------- */
function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = 'OK!';
    setTimeout(() => { btn.textContent = old; }, 1100);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    done();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else fallback();
}

/* ============================================================
   Markdown 渲染：实现抽到 md.js（纯逻辑，node 里能直接单测），
   这里只留一层薄封装 + 给代码块挂复制按钮的 DOM 接线。
   ============================================================ */
function mdToHtml(src) {
  return (window.PixelMD ? window.PixelMD.toHtml(src) : esc(src));
}

// 给渲染出来的代码块挂复制按钮（事件委托，一块只挂一次）
function bindMdCopy(root) {
  if (root.dataset.mdBound === '1') return;
  root.dataset.mdBound = '1';
  root.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.md-copy');
    if (!btn) return;
    const pre = btn.closest('.md-code').querySelector('pre');
    copyText(pre ? pre.textContent : '', btn);
  });
}

/* ============================================================
   消息时间线
   ============================================================ */
function showTimeline() { if (welcome) welcome.classList.add('hidden'); }
function scrollEnd() { log.scrollTop = log.scrollHeight; }

function addMsg(cls, who, txt) {
  showTimeline();
  const m = el('div', 'm ' + cls);
  m.appendChild(el('span', 'who', who));
  if (txt != null) m.appendChild(el('span', 'txt', txt));
  log.appendChild(m);
  scrollEnd();
  return m;
}

// PI 回复：who + 主体（+ 消息工具条）
function addBotMsg() {
  showTimeline();
  const m = el('div', 'm bot');
  m.appendChild(el('span', 'who', 'PI'));
  const main = el('div', 'm-main');
  const body = el('div', 'txt', '');
  main.appendChild(body);
  m.appendChild(main);
  log.appendChild(m);
  scrollEnd();
  return { m, main, body };
}

// 把纯文本正文变成 Markdown 成品 + 挂消息工具条
function finishBotMsg(body, text, withRetry) {
  body.innerHTML = mdToHtml(text);
  body.classList.add('md');
  bindMdCopy(body);
  const main = body.parentElement;
  if (main && !main.querySelector('.m-tools')) {
    const bar = el('div', 'm-tools');
    const c = el('button', 'm-btn', 'COPY');
    c.addEventListener('click', () => copyText(text, c));
    bar.appendChild(c);
    if (withRetry) {
      const r = el('button', 'm-btn', 'RETRY');
      r.title = '重发上一条输入（让 AI 再答一次）';
      r.addEventListener('click', retryLast);
      bar.appendChild(r);
    }
    main.appendChild(bar);
  }
  scrollEnd();
}

function retryLast() {
  if (S.busy) { addMsg('err', 'ERR', '正在跑，先停止再重试。'); return; }
  if (!S.lastUser) { addMsg('step', 'SYS', '&gt; 没有可重发的输入'); return; }
  input.value = S.lastUser;
  syncCursor();
  send();
}

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

/* ---------- 输入行方块光标 ---------- */
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

/* ---------- 思考链：默认只显示尾部，点一下展开完整 ---------- */
function toggleThink(row) {
  const txt = row.querySelector('.txt');
  if (!txt) return;
  const ex = txt.querySelector('.tk-full');
  if (ex) { ex.remove(); scrollEnd(); return; }
  txt.appendChild(el('div', 'tk-full', esc(row.dataset.full || '')));
  scrollEnd();
}

/* ============================================================
   上下文用量条
   ============================================================ */
function contextOf(modelName) {
  if (!modelName) return 0;
  const hit = S.models.find((m) => m.model === modelName);
  return hit ? hit.contextTokens : 0;
}
function setUsage(usage, modelName) {
  if (!usage) return;
  S.lastUsage = usage;            // 存下来：模型目录晚到时好补算分母
  S.lastUsageModel = modelName;
  const used = usage.totalTokens || 0;
  const ctx = contextOf(modelName);
  $('ub-text').textContent = fmtTokens(used) + ' / ' + (ctx ? fmtTokens(ctx) : '—');
  const pct = ctx ? Math.min(100, Math.round((used / ctx) * 100)) : 0;
  const fill = $('ub-fill');
  fill.style.width = (ctx ? Math.max(2, pct) : 0) + '%';
  fill.className = pct >= 85 ? 'hot' : (pct >= 60 ? 'warn' : '');
  $('sb-usage').title = ctx
    ? `上下文占用 ${pct}%（${used} / ${ctx} tokens）`
    : `已用 ${used} tokens（该模型上下文窗口未知）`;
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
  S.lastUser = text;
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
  refreshSessions();
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
        S.thinkEl = addMsg('think', '...',
          '<span class="tk-toggle" title="点一下展开完整思考过程">思考中' +
          '<span class="dots"><i></i><i></i><i></i></span></span> <span class="tk"></span>');
        S.thinkEl.dataset.full = '';
        break;
      case 'thinking_delta': {
        if (!S.thinkEl) break;
        S.thinkEl.dataset.full = (S.thinkEl.dataset.full || '') + (a.delta || '');
        const t = S.thinkEl.querySelector('.tk');
        if (t) {
          t.textContent = S.thinkEl.dataset.full.replace(/\s+/g, ' ').slice(-70);
          t.style.color = '#999';
        }
        break;
      }
      case 'thinking_end': {
        if (!S.thinkEl) break;
        const d = S.thinkEl.querySelector('.dots');
        if (d) d.remove();
        const tg = S.thinkEl.querySelector('.tk-toggle');
        if (tg && S.thinkEl.dataset.full) {
          tg.addEventListener('click', () => toggleThink(S.thinkEl));
        }
        scrollEnd();
        break;
      }
      case 'text_start': {
        setState('THINKING');
        const b = addBotMsg();
        S.bubble = b.body;
        S.botMain = b.main;
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
        if (S.bubble) {
          finishBotMsg(S.bubble, S.bubble.textContent, true);
          S.bubble = null;
        }
        break;
      case 'toolcall_start':
        setState('TOOL');
        S.toolEl = addMsg('tool', 'TOOL', '&gt; 调用工具: ' + esc(a.toolName || '?') + ' …');
        break;
      case 'toolcall_end': {
        const tc = a.toolCall || {};
        const name = tc.name || a.toolName || '?';
        if (S.toolEl) {
          S.toolEl.querySelector('.txt').innerHTML =
            '&gt; 调用工具: ' + esc(name) + ' ' + esc(briefOf(tc.arguments || {}).slice(0, 90));
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
      if (!S.curModel) $('kv-model2').textContent = ev.message.model;
      $('set-model').textContent = (ev.message.provider || '') + '/' + ev.message.model;
    }
    setUsage(ev.message.usage, ev.message.model);
    return;
  }
  if (ev.type === 'agent_settled') { endTurn(0); return; }
  if (ev.type === 'error') {
    addMsg('err', 'ERR', esc(ev.message || JSON.stringify(ev).slice(0, 200)));
    return;
  }
  // 工具执行开始：先把 args 存下来。
  // 注意 pi 的事件结构：args 只在 tool_execution_start 里有，
  // tool_execution_end 只给 result —— 不看真实事件很容易在这里写错。
  if (ev.type === 'tool_execution_start') {
    S.pendingTool[ev.toolCallId] = { name: ev.toolName, args: ev.args };
    setState('TOOL');
    return;
  }
  // 工具真实执行结束：右栏 TOOLS 记一条（完整入参 + 真实输出）
  if (ev.type === 'tool_execution_end') {
    const p = S.pendingTool[ev.toolCallId] || {};
    const args = (p.args !== undefined ? p.args : ev.args) || {};
    pushTool(
      ev.toolName || p.name || '?',
      briefOf(args),
      extractText(ev.result),
      JSON.stringify(args, null, 2)
    );
    delete S.pendingTool[ev.toolCallId];
  }
}
// 验收/调试入口：可以把真实事件流喂进来重跑渲染（test/verify-tools.js 用）
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
  } catch (e) { /* 列表刷不出来不该打断主流程 */ }
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
      else {
        const b = addBotMsg();
        finishBotMsg(b.body, m.text, false);
      }
    });
    S.round = h.msgs.filter((m) => m.role === 'user').length;
    $('kv-round').textContent = String(S.round);
    if (h.model) {
      $('kv-model').textContent = h.model;
      if (!S.curModel) $('kv-model2').textContent = h.model;
    }
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
  S.lastUser = '';
  $('kv-round').textContent = '0';
  $('kv-model').textContent = '—';
  if (!S.curModel) $('kv-model2').textContent = '默认';
  $('ub-text').textContent = '— / —';
  $('ub-fill').style.width = '0%';
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
    if (b.dataset.tab === 'files') loadFiles(S.fileDir || undefined);
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

    const head = el('button', 't-head');
    head.type = 'button';
    head.innerHTML =
      '<span class="t-caret">▶</span>' +
      '<span class="t-name">' + esc(t.name) + '</span>' +
      '<span class="t-arg"><span class="t-n">#' + (i + 1) + '</span>' + esc(t.arg || '') + '</span>';

    const body = el('div', 't-body hidden');
    const secIn = el('div', 't-sec');
    secIn.appendChild(el('span', 't-k', 'IN'));
    secIn.appendChild(el('pre', null, esc(t.argsJson || '(无参数)')));
    const secOut = el('div', 't-sec');
    secOut.appendChild(el('span', 't-k', 'OUT'));
    secOut.appendChild(el('pre', null, esc(t.out ? t.out.slice(0, 4000) : '(空输出)')));
    body.appendChild(secIn);
    body.appendChild(secOut);

    head.addEventListener('click', () => {
      const closed = body.classList.toggle('hidden');
      head.querySelector('.t-caret').textContent = closed ? '▶' : '▼';
    });

    d.appendChild(head);
    d.appendChild(body);
    box.appendChild(d);
  });
}
function pushTool(name, arg, out, argsJson) {
  S.tools.push({ name, arg, out: out || '', argsJson: argsJson || '' });
  renderTools();
}

async function loadFiles(dir) {
  if (!api) { $('files-root').textContent = '(演示模式无文件树)'; return; }
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
   模型 / 思考档位选择器
   ============================================================ */
const TH_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function modelLabel() {
  if (!S.curModel) return '默认';
  return S.curModel.model.length > 24 ? S.curModel.model.slice(0, 23) + '…' : S.curModel.model;
}
function paintModelBar() {
  $('kv-model2').textContent = modelLabel();
  $('kv-model2').title = S.curModel ? S.curModel.provider + '/' + S.curModel.model : '用 pi 自己的默认配置';
  $('kv-think').textContent = S.curThinking || '默认';
}

function renderThinkBtns() {
  const box = $('mdl-think-btns');
  box.innerHTML = '';
  TH_LEVELS.forEach((lv) => {
    const on = (S.curThinking || '') === lv;
    const b = el('button', 'th-btn' + (on ? ' on' : ''), lv || '默认');
    b.type = 'button';
    b.title = lv ? ('--thinking ' + lv) : '用 pi 默认档位';
    b.addEventListener('click', async () => {
      if (api) { const r = await api.setThinking(lv || null); if (r && r.current) S.curThinking = r.current.thinking; }
      else S.curThinking = lv || null;
      renderThinkBtns();
      paintModelBar();
    });
    box.appendChild(b);
  });
}

function renderModelList(q) {
  const box = $('mdl-list');
  box.innerHTML = '';
  const query = String(q || '').toLowerCase();
  const rows = S.models.filter((m) => !query || (m.provider + '/' + m.model).toLowerCase().includes(query));
  $('mdl-count').textContent = rows.length + ' 个模型';
  if (!rows.length) { box.appendChild(el('div', 'empty', '没有匹配的模型')); return; }

  let curProv = null;
  rows.forEach((m) => {
    if (m.provider !== curProv) {
      curProv = m.provider;
      const n = rows.filter((x) => x.provider === m.provider).length;
      box.appendChild(el('div', 'mdl-prov', esc(m.provider) + '  ·  ' + n));
    }
    const on = S.curModel && S.curModel.provider === m.provider && S.curModel.model === m.model;
    const tags = [m.context, m.thinking ? 'think' : '', m.images ? 'img' : ''].filter(Boolean).join(' · ');
    const d = el('div', 'mdl-item' + (on ? ' on' : ''));
    d.innerHTML = '<span class="mi-n">' + esc(m.model) + '</span><span class="mi-tag">' + esc(tags) + '</span>';
    d.title = m.provider + '/' + m.model + ' · 上下文 ' + m.context + ' · 最大输出 ' + m.maxOut;
    d.addEventListener('click', async () => {
      if (api) {
        const r = await api.setModel({ provider: m.provider, model: m.model });
        if (r && r.current) S.curModel = r.current.model;
      } else S.curModel = { provider: m.provider, model: m.model };
      paintModelBar();
      renderModelList($('mdl-q').value);
      // 换了模型，上下文窗口（用量条的分母）跟着换
      const ctx = contextOf(m.model);
      $('ub-fill').style.width = '0%';
      $('ub-fill').className = '';
      $('ub-text').textContent = '— / ' + (ctx ? fmtTokens(ctx) : '—');
    });
    box.appendChild(d);
  });
}

async function openModelPicker() {
  $('mask-model').classList.remove('hidden');
  renderThinkBtns();
  if (!api) { renderModelList(''); return; }
  if (!S.modelsLoaded) {
    $('mdl-count').textContent = '读取中…（真跑 pi --list-models）';
    const r = await api.models();
    if (r && r.ok && r.models && r.models.length) {
      S.models = r.models;
      S.modelsLoaded = true;
      if (r.current) { S.curModel = r.current.model; S.curThinking = r.current.thinking; }
    } else {
      $('mdl-count').textContent = '读取失败：' + ((r && r.error) || '未知原因');
      return;
    }
  }
  renderThinkBtns();
  renderModelList($('mdl-q').value);
  $('mdl-q').focus();
}

function closeModelPicker() { $('mask-model').classList.add('hidden'); }

/* ============================================================
   命令面板（/ 开头）+ 文件引用（@ 开头）
   ============================================================ */
function switchTab(t) {
  const b = document.querySelector('.rtab[data-tab="' + t + '"]');
  if (b) b.click();
}

const COMMANDS = [
  { k: '/new',    d: '新建会话（清空上下文）',       run: () => newSession() },
  { k: '/model',  d: '切换模型 / 思考档位',          run: () => openModelPicker() },
  { k: '/stop',   d: '停止当前这一轮',                run: () => doAbort() },
  { k: '/tools',  d: '打开右栏 TOOLS',                run: () => switchTab('tools') },
  { k: '/files',  d: '打开右栏 FILES',                run: () => switchTab('files') },
  { k: '/clear',  d: '清空当前视图（不动会话文件）',   run: () => { log.innerHTML = ''; if (welcome) welcome.classList.remove('hidden'); } },
  { k: '/info',   d: '查看后端 / 会话信息',            run: () => $('btn-settings').click() }
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

  if (v.startsWith('/')) {
    const q = v.slice(1).toLowerCase();
    pal.items = COMMANDS
      .filter((c) => c.k.slice(1).toLowerCase().includes(q) || c.d.includes(v.slice(1)))
      .map((c) => ({ label: c.k, desc: c.d, run: c.run }));
    if (pal.items.length) { if (!pal.open || pal.mode !== 'cmd') pal.idx = 0; openPalette('cmd', 'COMMANDS'); renderPalette(); }
    else closePalette();
    return;
  }

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
  if (e.key === 'Escape') {
    if (!$('mask-model').classList.contains('hidden')) { closeModelPicker(); return; }
    if (document.activeElement !== input) doAbort();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') { e.preventDefault(); openModelPicker(); }
});
document.addEventListener('mousedown', (e) => {
  if (!pal.open) return;
  if (e.target === input || (e.target.closest && e.target.closest('#palette'))) return;
  closePalette();
});
btnStop.addEventListener('click', doAbort);
$('btn-new').addEventListener('click', newSession);
$('btn-model').addEventListener('click', openModelPicker);

/* 模型选择器关闭 */
$('mdl-x').addEventListener('click', closeModelPicker);
$('mask-model').addEventListener('click', (e) => { if (e.target === $('mask-model')) closeModelPicker(); });
$('mdl-q').addEventListener('input', (e) => renderModelList(e.target.value));
$('mdl-default').addEventListener('click', async () => {
  if (api) { const r = await api.setModel(null); if (r && r.current) S.curModel = r.current.model; }
  else S.curModel = null;
  paintModelBar();
  renderModelList($('mdl-q').value);
  $('ub-fill').style.width = '0%';
  $('ub-fill').className = '';
  $('ub-text').textContent = '— / —';
});

/* 设置面板 */
$('btn-settings').addEventListener('click', () => {
  mask.classList.remove('hidden');
  if (api) api.info().then((i) => {
    $('set-cli').textContent = i.cli || '未找到 pi 入口';
    $('set-session').textContent = i.session;
    $('set-mode').textContent = i.mode;
    $('kv-cwd').textContent = i.cwd || '—';
    $('kv-cwd').title = i.cwd || '';
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
   演示模式：没有 pixelAPI 时自己演一段（顺便验 Markdown 渲染）
   ============================================================ */
function demoReply(text) {
  setState('THINKING');
  setTimeout(() => {
    S.thinkEl = addMsg('think', '...',
      '<span class="tk-toggle">思考中<span class="dots"><i></i><i></i><i></i></span></span> <span class="tk"></span>');
    S.thinkEl.dataset.full = '演示模式：这里会放完整的思考过程，点标题可展开。';
    const tg = S.thinkEl.querySelector('.tk-toggle');
    if (tg) tg.addEventListener('click', () => toggleThink(S.thinkEl));
  }, 300);
  setTimeout(() => {
    if (S.thinkEl) {
      const d = S.thinkEl.querySelector('.dots');
      if (d) d.remove();
    }
    const b = addBotMsg();
    S.bubble = b.body;
    const reply = '（演示模式）收到：' + text + '\n\n' +
      '## Markdown 渲染演示\n\n' +
      '- **粗体**、*斜体*、`行内代码`、~~删除线~~\n' +
      '- 无序列表第二项\n\n' +
      '1. 有序项一\n2. 有序项二\n\n' +
      '```js\nconsole.log("代码块");\n```\n\n' +
      '| 列 A | 列 B |\n| --- | ---: |\n| 左对齐 | 右对齐 |\n\n' +
      '> 引用块\n\n---\n\n结束。';
    let i = 0;
    const t = setInterval(() => {
      addCaret();
      b.body.textContent += reply[i++] || '';
      addCaret();
      scrollEnd();
      if (i >= reply.length) {
        clearInterval(t);
        removeCaret();
        finishBotMsg(b.body, reply, true);
        S.bubble = null;
        endTurn(0);
      }
    }, 10);
  }, 900);
}

/* ============================================================
   启动
   ============================================================ */
syncCursor();
setState('IDLE');
paintModelBar();
setTimeout(() => input.focus(), 120);
refreshSessions();
if (api) {
  api.info().then((i) => {
    if (i && i.cwd) { $('kv-cwd').textContent = i.cwd; $('kv-cwd').title = i.cwd; }
  });
  api.files().then((r) => {
    if (r && r.items) { S.fileCache = r.items; S.fileDir = r.dir; }
  }).catch(() => {});
  // 启动就把模型目录拉下来：用量条要拿模型的上下文窗口当分母
  api.models().then((r) => {
    if (r && r.ok && r.models && r.models.length) {
      S.models = r.models;
      S.modelsLoaded = true;
      if (r.current) { S.curModel = r.current.model; S.curThinking = r.current.thinking; }
      paintModelBar();
      const cur = S.curModel ? S.curModel.model : $('kv-model').textContent;
      const ctx = contextOf(cur);
      if (S.lastUsage) {
        setUsage(S.lastUsage, S.lastUsageModel || cur);   // 目录刚到，补算分母
      } else if (ctx) {
        $('ub-text').textContent = '— / ' + fmtTokens(ctx);
        $('sb-usage').title = '上下文总窗口 ' + ctx + ' tokens';
      }
    }
  }).catch(() => {});
}

const q = new URLSearchParams(location.search);
if (q.get('auto')) {
  setTimeout(() => { input.value = q.get('auto'); syncCursor(); send(); }, 3000);
}
