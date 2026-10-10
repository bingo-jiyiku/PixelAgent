// ============================================================
// renderer.js —— 界面逻辑（纯浏览器 JS，不碰 Node）
// 干三件事：
//   1) 把用户输入发给主进程 -> pi
//   2) 把 pi 吐回来的 JSON 事件流画成"打字机 + 状态行"
//   3) 状态标签 / 计时 / 置信度方格这些装饰件
// ============================================================
'use strict';

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const mirror = $('mirror');
const cursor = $('cursor');
const btnSend = $('btn-send');
const btnStop = $('btn-stop');
const btnNew = $('btn-new');
const btnSettings = $('btn-settings');
const mask = $('mask');

const api = window.pixelAPI || null;   // 用浏览器直接打开时没有它，会走演示模式

/* ---------- 运行状态 ---------- */
const S = {
  busy: false,        // 这一轮是不是还在跑
  round: 0,           // 轮次
  startedAt: 0,       // 本轮开始时间
  timer: null,        // 计时器
  thinkEl: null,      // 当前"思考中"行
  bubble: null,       // 当前回复的气泡
  toolEl: null,       // 当前工具状态行
  confTimer: null,    // 置信度动画
  confVal: 0,
  lastState: 'IDLE'
};

// 给截图脚本读的就绪标记（渲染层自己维护，不污染业务逻辑）
window.__pixel = S;

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
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// 注意：这里用 innerHTML，但所有外部内容（用户话、pi 回复、工具参数）
// 都先过 esc() 转义，静态字符串不含变量，所以没有注入风险。
function addMsg(cls, who, txt) {
  const m = el('div', 'm ' + cls);
  m.appendChild(el('span', 'who', who));
  if (txt != null) m.appendChild(el('span', 'txt', txt));
  log.appendChild(m);
  scrollEnd();
  return m;
}

function scrollEnd() { log.scrollTop = log.scrollHeight; }

/* ---------- 状态标签 ---------- */
function setState(state, detail) {
  S.lastState = state;
  document.querySelectorAll('.tag').forEach((t) => {
    t.classList.toggle('on', t.dataset.state === state);
  });
  $('kv-state').textContent = state;
  // 管线高亮：跑的时候亮第一步到第三步
  document.querySelectorAll('.pipe-line').forEach((p, i) => {
    p.classList.remove('done', 'live');
    if (state === 'IDLE') return;
    if (i < 3) p.classList.add('live');
    if (state === 'DONE') p.classList.add('done');
  });
  // 置信度条
  if (state === 'THINKING' || state === 'TOOL') startConf();
  else if (state === 'DONE') stopConf(10, 'COMPLETE');
  else if (state === 'IDLE') stopConf(0, 'STANDBY');
  if (detail) $('callout').innerHTML = detail;
}

/* ---------- 计时 ---------- */
function startTimer() {
  S.startedAt = Date.now();
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    $('kv-time').textContent = ((Date.now() - S.startedAt) / 1000).toFixed(1) + 's';
  }, 100);
}
function stopTimer() {
  clearInterval(S.timer);
  S.timer = null;
}

/* ---------- 置信度方格动画 ---------- */
function startConf() {
  if (S.confTimer) return;
  S.confTimer = setInterval(() => {
    S.confVal = Math.min(9, S.confVal + 1);
    paintConf(S.confVal);
    $('conf-cap').textContent = 'PROCESSING ' + Math.round((S.confVal / 10) * 100) + '%';
  }, 320);
}
function stopConf(v, cap) {
  clearInterval(S.confTimer);
  S.confTimer = null;
  S.confVal = v;
  paintConf(v);
  $('conf-cap').textContent = cap;
}
function paintConf(v) {
  $('conf').querySelectorAll('i').forEach((sq, i) => {
    sq.classList.toggle('on', i < v);
    sq.classList.toggle('dim', i < v && i < v - 4);
  });
}

/* ---------- 输入行的方块光标（用镜像量出文字宽度） ---------- */
function syncCursor() {
  mirror.textContent = input.value;
  const w = Math.min(mirror.offsetWidth, input.clientWidth - 12);
  cursor.style.left = w + 'px';
}
input.addEventListener('input', syncCursor);
input.addEventListener('focus', () => { cursor.style.background = '#ff2d95'; });
input.addEventListener('blur', () => { cursor.style.background = '#7ff0ab'; });

/* ---------- 打字机尾部光标：回复流出时跟气泡最后一个字 ---------- */
function addCaret() {
  if (!S.bubble || S.bubble.querySelector('.stream-caret')) return;
  const c = document.createElement('span');
  c.className = 'stream-caret';
  c.setAttribute('aria-hidden', 'true');
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
  if (S.busy) {
    addMsg('err', 'ERR', '上一轮还没结束，先按 ESC 停掉它。');
    return;
  }

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

/* 一轮结束的统一收尾 */
function endTurn(code) {
  S.busy = false;
  stopTimer();
  btnStop.classList.add('hidden');
  removeCaret();          // 收尾也兜一遍：异常退出时尾部光标不留
  setState('DONE');
  if (code !== 0 && code != null) {
    addMsg('err', 'ERR', 'pi 退出码 ' + code + '（看看是不是没认证）');
  }
}

/* ============================================================
   处理 pi 吐回来的事件（这是接线的核心）
   ============================================================ */
function onMsg(msg) {
  if (!msg) return;

  if (msg.kind === 'boot') {
    $('set-cli').textContent = msg.cli || '未找到';
    $('set-session').textContent = msg.session || '—';
    return;
  }

  if (msg.kind === 'state') { return; }   // 主进程的主动状态，这里以事件为准

  if (msg.kind === 'exit') {
    if (msg.error) addMsg('err', 'ERR', esc(msg.error));
    endTurn(msg.code);
    return;
  }

  if (msg.kind !== 'ev') return;
  const ev = msg.ev;
  if (!ev || !ev.type) return;

  // --- 子类型：message_update 里的 assistantMessageEvent ---
  if (ev.type === 'message_update' && ev.assistantMessageEvent) {
    const a = ev.assistantMessageEvent;
    switch (a.type) {
      case 'thinking_start':
        setState('THINKING');
        S.thinkEl = addMsg('think', '...', '思考中<span class="dots"><i></i><i></i><i></i></span> <span class="tk"></span>');
        break;
      case 'thinking_delta': {
        // 思考内容只留一小段当"显形"，太长会刷屏
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
      case 'text_start':
        setState('THINKING');
        S.bubble = el('span', 'bubble', '');
        const m = el('div', 'm bot');
        m.appendChild(el('span', 'who', 'PI'));
        m.appendChild(S.bubble);
        log.appendChild(m);
        scrollEnd();
        break;
      case 'text_delta':
        if (S.bubble) {
          addCaret();                       // 每字流进来时，尾巴挂着方块光标
          S.bubble.textContent += a.delta || '';
          addCaret();                       // textContent 赋值会清掉子节点，补回来
          scrollEnd();
        }
        break;
      case 'text_end':
        removeCaret();                      // 回复写完，光标下班
        break;
      case 'toolcall_start':
        setState('TOOL');
        S.toolEl = addMsg('tool', 'TOOL', '&gt; 调用工具: ' + esc(a.toolName || '?') + ' …');
        break;
      case 'toolcall_end': {
        if (!S.toolEl) break;
        const tc = a.toolCall || {};
        const args = tc.arguments || {};
        const brief = args.command || args.path || args.file || args.pattern ||
          JSON.stringify(args).slice(0, 60);
        S.toolEl.querySelector('.txt').innerHTML =
          '&gt; 调用工具: ' + esc(tc.name || '') + ' ' + esc(String(brief).slice(0, 80));
        scrollEnd();
        break;
      }
      default:
        break;
    }
    return;
  }

  // --- 一轮结束：顺便把模型名抓下来 ---
  if (ev.type === 'turn_end' && ev.message) {
    const model = (ev.message.provider || '') + '/' + (ev.message.model || '');
    if (ev.message.model) {
      $('kv-model').textContent = ev.message.model;
      $('set-model').textContent = model;
    }
    return;
  }

  if (ev.type === 'agent_settled') {
    endTurn(0);
    return;
  }

  if (ev.type === 'error' || ev.type === 'raw_line') {
    if (ev.type === 'error') addMsg('err', 'ERR', esc(ev.message || JSON.stringify(ev).slice(0, 200)));
  }
}

if (api) api.onMsg(onMsg);

/* ============================================================
   按钮 / 键盘
   ============================================================ */
btnSend.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); send(); }
  if (e.key === 'Escape') { e.preventDefault(); doAbort(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== input) doAbort();
});

function doAbort() {
  if (!S.busy) return;
  if (api) api.abort();
  addMsg('step', 'STOP', '&gt; 已手动停止这一轮');
  endTurn(0);
}

btnNew.addEventListener('click', () => {
  const go = () => {
    log.innerHTML = '';
    addMsg('sys', 'SYS', '新会话已开启，上下文清空。');
    S.round = 0;
    $('kv-round').textContent = '0';
    $('kv-model').textContent = '读取中…';
    setState('IDLE');
    input.focus();
  };
  if (api) api.newSession().then(go).catch(go);
  else go();
});

/* 设置面板：只读展示 pi 的信息 */
btnSettings.addEventListener('click', () => {
  mask.classList.remove('hidden');
  if (api) api.info().then((i) => {
    $('set-cli').textContent = i.cli || '未找到 pi 入口';
    $('set-session').textContent = i.session;
    $('set-mode').textContent = i.mode;
    if (i.cli === null) $('set-model').textContent = 'pi 未安装';
  });
});
$('dlg-close').addEventListener('click', () => mask.classList.add('hidden'));
$('dlg-x').addEventListener('click', () => mask.classList.add('hidden'));
mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.add('hidden'); });

$('btn-mode').addEventListener('click', () => {
  addMsg('step', 'MODE', '&gt; 当前模式：PIXEL TERMINAL v1.0（pi · json 流）');
});

/* ============================================================
   假标题栏按钮（原生窗口关掉后，最小化/最大化/关闭自己来）
   ============================================================ */
$('tb-min').addEventListener('click', () => window.pixelAPI && window.pixelAPI.winMin());
$('tb-max').addEventListener('click', () => window.pixelAPI && window.pixelAPI.winMax());
$('tb-close').addEventListener('click', () => window.pixelAPI && window.pixelAPI.winClose());

/* ESC 关弹窗已有；无原生窗口后双击标题栏也能最大化，补一条双击空隙处关弹窗 */
$('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('.tb-btn')) return;   // 点按钮不触发
  window.pixelAPI && window.pixelAPI.winMax();
});

/* ============================================================
   演示模式：没有 pixelAPI（比如用浏览器直接打开 index.html）时
   自己模拟一段流式回复，方便看样式 / 截图。
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
    const reply = '（演示模式）收到：' + text + '\n真实运行时这段话会由 pi 逐字流进来。按回车发送下一句。';
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
   启动：光标归位 + 支持 ?auto=xxx 自动发一句（截图脚本用）
   ============================================================ */
syncCursor();
setState('IDLE');
stopConf(0, 'STANDBY');
setTimeout(() => input.focus(), 120);

const q = new URLSearchParams(location.search);
if (q.get('auto')) {
  // 延迟 3 秒再自动发，好让截图脚本先拍到干净的待机界面
  setTimeout(() => { input.value = q.get('auto'); send(); }, 3000);
}
