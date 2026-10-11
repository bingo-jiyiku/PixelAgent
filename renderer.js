/* ============================================================
   renderer.js —— 界面逻辑（纯浏览器 JS，不碰 Node）

   1) 消息时间线：流式打字机 + Markdown 渲染 + 消息级操作（复制/重发）
   2) 图片附件：粘贴 / 拖拽 / 点选 → 预览条 → 随消息一起发（走 @path 落盘）
   3) `!` 前缀：不经模型，直接在本机跑 shell
   4) 左栏：会话列表（真读 .sessions/）+ 重命名/删除/导出 + 跨会话搜索
   5) 右栏：TOOLS（可展开）/ TODOS（真 todo 工具）/ FILES（可换目录）/ AGENTS（真扩展清单）
   6) 底部：prompt + / 命令 + @ 文件引用 + 状态栏（用量条 / 模型 / 思考档位 / 视觉能力）
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
  botMain: null,
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
  pendingTool: {},    // toolCallId -> {name, args}：args 只在 start 事件里有
  attachments: [],    // 待发送的图片附件
  attLoading: 0,      // 正在读取中的图片张数（算上限时要算上，否则连拖 10 张会全进来）
  attSent: 0,         // 这一轮实际发出去几张图（用来对账"图到底进没进请求"）
  imgIn: 0,           // pi 回显的 user 消息里真的有几个 image 块
  imgWarned: false,   // 这一轮已经就图片问题提过醒，别重复刷屏
  todos: [],          // 真 todo 工具吐出来的待办
  subs: [],           // 会话内子代理/嵌套调用活动
  exts: null,         // 已装扩展（真跑 pi list）
  shellEls: {},       // shell 执行 id -> {out, code}
  searchTimer: null,
  searchQ: ''
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
  const pick = args.command || args.path || args.file || args.pattern || args.query || args.task || args.prompt;
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
    btn.textContent = '已复制';
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
// 自动滚到底：受设置「新消息自动到底」控制（关掉后由用户自己滚，不再抢滚动条）
function scrollEnd() { if (!CFG || CFG.autoScroll !== false) log.scrollTop = log.scrollHeight; }

// 面向用户的标签一律中文；代码/样式/测试里仍用英文内部键（WHO_ZH 只负责显示层）
const WHO_ZH = {
  PI: '助手', YOU: '你', SYS: '系统', ERR: '错误',
  IMG: '图片', TOOL: '工具', STOP: '已停止', SHELL: '命令'
};
function whoZh(w) { return WHO_ZH[w] || w; }

// 主进程回传的 reason 是英文码（内部约定，别动）；显示前翻一下，别把 NOT_FOUND 直接甩给用户
const REASON_ZH = {
  BUSY: '上一轮还没结束',
  IMAGE_REJECTED: '图片没收下',
  EMPTY: '内容为空',
  BAD_SEQ: '会话号不对',
  NAME_TAKEN: '这个名字已经有会话在用了',
  NAME_EMPTY: '名字不能为空',
  NOT_FOUND: '文件不存在',
  TRASH_FAILED: '回收站操作失败',
  NO_WINDOW: '窗口不可用',
  CANCELED: '已取消',
  EXPORT_FAILED: '导出失败',
  NOT_DIR: '不是目录',
  SPAWN_FAILED: '启动子进程失败',
  unknown: '未知原因'
};
function reasonZh(r) { return (r && REASON_ZH[r]) || r || '未知'; }

// 扩展来源标签（pi list 里解析出来的）：npm 是包名，保留；其余给中文
const EXT_SRC_ZH = { npm: 'npm 包', file: '本地文件', git: 'Git 仓库', local: '自带', workspace: '工作区' };
function extSrcZh(s) { return (s && EXT_SRC_ZH[s]) || s || ''; }

function addMsg(cls, who, txt, extra) {
  showTimeline();
  const m = el('div', 'm ' + cls);
  m.appendChild(el('span', 'who', whoZh(who)));
  if (txt != null) m.appendChild(el('span', 'txt', txt));
  if (extra) m.appendChild(el('span', 'att-note', extra));
  log.appendChild(m);
  scrollEnd();
  return m;
}

// PI 回复：who + 主体（+ 消息工具条）
function addBotMsg() {
  showTimeline();
  const m = el('div', 'm bot');
  m.appendChild(el('span', 'who', whoZh('PI')));
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
    const c = el('button', 'm-btn', '复制');
    c.addEventListener('click', () => copyText(text, c));
    bar.appendChild(c);
    if (withRetry) {
      const r = el('button', 'm-btn', '重答');
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
// 显示用中文；dataset.status / dataset.state 仍是英文内部值（CSS 动画选择器依赖）
const STATE_ZH = { IDLE: '空闲', THINKING: '思考中', TOOL: '处理中', DONE: '完成' };
const CAP_ZH = { THINKING: '思考中…', TOOL: '处理中…', DONE: '完成！', IDLE: '待机' };
function setState(state) {
  S.lastState = state;
  const tag = $('sb-state');
  if (tag) {
    tag.textContent = STATE_ZH[state] || state;
    tag.dataset.status = state;
    tag.classList.toggle('on', state !== 'IDLE');
  }
  const girl = $('pixel-girl');
  const scene = $('girl-scene');
  const cap = $('girl-cap');
  if (girl) girl.dataset.state = state;
  if (scene) scene.dataset.state = state;
  if (cap) cap.textContent = CAP_ZH[state] || state;
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
   上下文用量条 + 当前模型的看图能力
   ============================================================ */
function contextOf(modelName) {
  if (!modelName) return 0;
  const hit = S.models.find((m) => m.model === modelName);
  return hit ? hit.contextTokens : 0;
}

// null = 不知道（模型目录还没到），true/false = 明确
function visionOf(modelName) {
  if (!modelName || modelName === '—') return null;
  const hit = S.models.find((m) => m.model === modelName);
  return hit ? !!hit.images : null;
}
function activeModelName() {
  return S.curModel ? S.curModel.model : $('kv-model').textContent;
}
function updateVision() {
  const box = $('sb-vis');
  if (!box) return;
  const v = visionOf(activeModelName());
  const b = $('kv-vis');
  box.classList.toggle('yes', v === true);
  box.classList.toggle('no', v === false);
  if (b) b.textContent = v === true ? '支持' : (v === false ? '不支持' : '?');
  box.title = v === true
    ? '当前模型支持看图，可以直接粘贴/拖拽图片进来'
    : v === false
      ? '当前模型不支持看图：发图后它只能靠命令行工具去认字猜，建议切到带「看图」标记的模型'
      : '未知（模型目录还没读到）';
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
   图片附件
   ------------------------------------------------------------
   为什么要有预览条：图一旦发出去就落盘成路径了，用户得在发之前
   确认「我到底要发哪几张」。而且默认模型很可能看不懂图，
   这里要提前用当前模型的 images 能力给出警告，别让用户以为 AI 眼瞎。
   ============================================================ */
const MAX_ATT_BYTES = 16 * 1024 * 1024;

function addAttachment(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    addMsg('err', 'ERR', '只支持图片（这份是 ' + esc(file.type || '未知类型') + '）');
    return;
  }
  if (file.size > MAX_ATT_BYTES) {
    addMsg('err', 'ERR', '图片太大（' + fmtBytes(file.size) + '，上限 16M）');
    return;
  }
  // 张数上限走设置（默认 4）。超了要**说清楚**而不是静默丢掉 —— 静默丢图
  // 会让人以为"图发出去了"，跟 pi 那边静默丢图是同一类坑。
  const cap = (CFG && CFG.maxImages) ? CFG.maxImages : 4;
  const pending = S.attachments.length + S.attLoading;
  if (pending >= cap) {
    addMsg('err', 'ERR', '一次最多带 ' + cap + ' 张图（现在已有 ' + pending + ' 张，可在「设置」里调）');
    return;
  }
  S.attLoading += 1;
  const r = new FileReader();
  r.onerror = () => { S.attLoading = Math.max(0, S.attLoading - 1); addMsg('err', 'ERR', '这张图读不出来（' + esc(file.name || '未命名') + '）'); };
  r.onload = () => {
    S.attLoading = Math.max(0, S.attLoading - 1);
    S.attachments.push({
      id: 'a' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: file.name || ('pasted-' + Date.now() + '.png'),
      size: file.size,
      mime: file.type || 'image/png',
      dataUrl: r.result
    });
    renderAtt();
  };
  r.readAsDataURL(file);
}

function renderAtt() {
  const bar = $('attbar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!S.attachments.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  // 模型看不懂图就先说清楚，不然后面会怀疑「AI 怎么在瞎猜」
  const vis = visionOf(activeModelName());
  if (vis === false) {
    bar.appendChild(el('div', 'att-warn',
      '⚠ 当前模型（' + esc(activeModelName()) + '）不支持看图 —— 发出去它只能靠命令行工具去认字猜，建议切到带「看图」标记的模型'));
  } else if (vis === null) {
    // 未知 ≠ 没问题。这里不当成"能看图"（那是在替用户拍胸脯），
    // 也不当成"不能看图"（那会天天误警）。就说实话，并告诉他怎么看结果。
    bar.appendChild(el('div', 'att-warn note',
      '模型「' + esc(activeModelName() || '默认') + '」看不看得懂图还没确认 —— 发出去后如果它没看见图，时间线里会有明确提示'));
  }

  S.attachments.forEach((a) => {
    const d = el('div', 'att-item');
    const img = el('img');
    img.src = a.dataUrl;
    img.alt = a.name;
    d.appendChild(img);
    d.appendChild(el('span', 'att-n', esc(a.name)));
    d.appendChild(el('span', 'att-s', fmtBytes(a.size)));
    const x = el('button', 'att-x', '✕');
    x.type = 'button';
    x.title = '移除';
    x.addEventListener('click', () => {
      S.attachments = S.attachments.filter((z) => z.id !== a.id);
      renderAtt();
    });
    d.appendChild(x);
    bar.appendChild(d);
  });
}

function clearAtt() { S.attachments = []; renderAtt(); }

/* ---------- 粘贴图片 ---------- */
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  let got = 0;
  const items = cd.items || [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type || '')) {
      const f = it.getAsFile && it.getAsFile();
      if (f) { addAttachment(f); got++; }
    }
  }
  // 只在真的吃到了图片时才阻止默认行为，
  // 否则会把「往输入框里粘贴文字」也一起吞掉
  if (got) { e.preventDefault(); addMsg('step', 'SYS', '&gt; 已加入 ' + got + ' 张图片'); }
});

/* ---------- 拖拽图片 ---------- */
function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) return true;
  return !!(dt.files && dt.files.length);
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('dropmask').classList.remove('hidden');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropmask').classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropmask').classList.add('hidden');
  const files = Array.prototype.slice.call(e.dataTransfer.files || []);
  files.forEach(addAttachment);
});

/* ---------- 点选图片 ---------- */
const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.accept = 'image/*';
filePicker.multiple = true;
filePicker.style.display = 'none';
document.body.appendChild(filePicker);
filePicker.addEventListener('change', () => {
  Array.prototype.slice.call(filePicker.files || []).forEach(addAttachment);
  filePicker.value = '';
});
if ($('btn-att')) $('btn-att').addEventListener('click', () => filePicker.click());

/* ============================================================
   `!` 直接执行 shell
   ------------------------------------------------------------
   这不花 token，也不该让模型替用户决定跑不跑 —— 用户敲 ! 就是要自己跑。
   输出走主进程流式推回来。
   ============================================================ */
let shellSeq = 0;

function runShell(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return;
  showTimeline();

  const id = 'sh' + (++shellSeq);
  const m = el('div', 'm shell');
  m.appendChild(el('span', 'who', whoZh('SHELL')));
  const main = el('div', 'm-main');
  main.appendChild(el('span', 'sh-cmd', esc(text)));
  const out = el('div', 'sh-out');
  const code = el('span', 'sh-code', '运行中');
  main.appendChild(out);
  main.appendChild(code);
  m.appendChild(main);
  log.appendChild(m);
  scrollEnd();

  S.shellEls[id] = { out, code };

  if (!api) {
    out.textContent = '（演示模式：浏览器直开时不会真的执行命令）';
    code.textContent = '演示';
    delete S.shellEls[id];
    return;
  }
  api.runShell({ id, cmd: text }).then((r) => {
    if (r && r.ok === false) {
      const t = S.shellEls[id];
      if (t) {
        t.out.textContent += '启动失败：' + reasonZh(r.reason || r.error) + '\n';
        t.code.textContent = '失败';
        t.code.classList.add('bad');
        delete S.shellEls[id];
      }
    }
  }).catch((e) => {
    const t = S.shellEls[id];
    if (t) {
      t.out.textContent += String(e && e.message ? e.message : e) + '\n';
      t.code.textContent = '失败';
      t.code.classList.add('bad');
      delete S.shellEls[id];
    }
  });
}

/* ============================================================
   发送
   ============================================================ */
function send() {
  const raw = input.value;
  const text = raw.trim();
  const nAtt = S.attachments.length;

  // `!` 前缀：直接跑命令，不进模型。带图时不当命令处理（避免歧义）
  if (text.startsWith('!') && !nAtt) {
    input.value = '';
    syncCursor();
    closePalette();
    addMsg('user', 'YOU', esc(text));
    runShell(text.slice(1));
    return;
  }

  if (!text && !nAtt) return;
  if (S.busy) { addMsg('err', 'ERR', '上一轮还没结束，先按 ESC 停掉它。'); return; }

  const images = S.attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl }));

  input.value = '';
  syncCursor();
  S.lastUser = text;
  S.round += 1;
  S.attSent = nAtt;      // 记账：这一轮发了几张图，等 pi 回显时对账
  S.imgIn = 0;
  S.imgWarned = false;
  $('kv-round').textContent = String(S.round);
  S.busy = true;
  btnStop.classList.remove('hidden');
  setState('THINKING');
  startTimer();
  addMsg('user', 'YOU', esc(text || '(只看图)'), nAtt ? ('图×' + nAtt) : null);
  clearAtt();

  if (!api) { demoReply(text); return; }

  api.ask({ text, images }).then((r) => {
    if (r && r.ok === false) {
      if (r.reason === 'IMAGE_REJECTED') {
        addMsg('err', 'IMG', '这些图没收下，所以没发出去：' + esc(rejText(r.rejected)));
      } else {
        addMsg('err', 'ERR', '主进程拒绝了这次请求：' + esc(reasonZh(r.reason)));
      }
      endTurn(-1);
      return;
    }
    // 部分被拒：好的照发，坏的要说清楚为什么（不能让用户以为全都发出去了）
    if (r && Array.isArray(r.rejected) && r.rejected.length) {
      addMsg('err', 'IMG', '有 ' + r.rejected.length + ' 张图没能发送：' + esc(rejText(r.rejected)));
    }
  }).catch((e) => {
    addMsg('err', 'ERR', '发送失败：' + (e && e.message ? e.message : e));
    endTurn(-1);
  });
}

// 把附件被拒的原因拼成一行给人看的话
function rejText(rejected) {
  if (!Array.isArray(rejected) || !rejected.length) return '';
  return rejected.map((x) => (x && x.name ? x.name : '一张图') + '（' + ((x && x.reason) || '未知原因') + '）').join('；');
}

function endTurn(code) {
  S.busy = false;
  stopTimer();
  btnStop.classList.add('hidden');
  removeCaret();
  setState('DONE');
  if (code !== 0 && code != null) {
    addMsg('err', 'ERR', 'pi 退出码 ' + code + '（看看是不是没认证 / 没 key）');
  }
  refreshSessions();
}

function doAbort() {
  // 计数放在 busy 判断之前：见 window.__pixelAborts 处的注释（测试要能看见"被叫了几次"）
  if (typeof window.__pixelAborts === 'number') window.__pixelAborts++;
  if (!S.busy) return;
  if (api) api.abort();
  addMsg('step', 'STOP', '&gt; 已手动停止这一轮');
  endTurn(0);
}

/* ============================================================
   TODO 工具结果的解析
   实现已抽到 parse.js（纯逻辑，node 里能直接喂真实抓下来的事件跑断言）。
   这里只留一层薄封装。
   ============================================================ */
function todosFromToolResult(ev) {
  if (window.PixelParse) return window.PixelParse.todosFromToolResult(ev);
  return { known: false, list: [] };
}

/* ============================================================
   图片"没进请求"的兜底检测（第二层，发之后）
   ------------------------------------------------------------
   pi 遇到处理不了的图时**不报错**：它把 image 块悄悄删掉，
   只在 user 消息的文本里留一句方括号标记。界面上完全看不出来。
   上一轮我就是被这个坑住的 —— 端到端验收红了两轮，
   却一直以为图已经发出去了（JSON 里明明有 @路径）。

   判定逻辑本体在 parse.js（纯函数，能拿真实抓包喂断言），
   这里只做"翻译成界面上的话"。
   ============================================================ */
// 标记种类 -> 给用户看的解释
const IMG_OMIT_WHY = {
  resize: 'pi 没能把这张图处理进请求（图本身解不开 / 尺寸或体积超过内联上限）。换一张能正常打开的图再试。',
  nomodel: '当前模型不看图，图被丢掉了。用 /model 换一个在列表里带「图」标记的模型。'
};

// 从一条 user 消息里抽出：有几个 image 块 + 有没有丢图标记
function inspectUserContent(content) {
  if (window.PixelParse && window.PixelParse.inspectUserContent) {
    return window.PixelParse.inspectUserContent(content);
  }
  // 兜底：parse.js 没加载也别把判定整个丢掉
  let imgs = 0;
  const texts = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'image') imgs++;
      else if (c.type === 'text') texts.push(String(c.text || ''));
    }
  }
  const t = texts.join('\n');
  let omit = null;
  if (/\[Image omitted/i.test(t)) omit = { key: 'resize', text: '' };
  else if (/\[Current model does not support images/i.test(t)) omit = { key: 'nomodel', text: '' };
  return { imgs: imgs, omit: omit, text: t };
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

  // `!` shell 的流式输出
  if (msg.kind === 'shell') {
    const t = S.shellEls[msg.id];
    if (!t) return;
    if (msg.done) {
      t.code.textContent = '退出码 ' + msg.code;
      if (msg.code !== 0) t.code.classList.add('bad');
      delete S.shellEls[msg.id];
      scrollEnd();
    } else if (msg.data) {
      t.out.appendChild(el('span', msg.stream === 'err' ? 'sh-err' : null, esc(msg.data)));
      scrollEnd();
    }
    return;
  }

  if (msg.kind === 'exit') {
    if (msg.error) addMsg('err', 'ERR', esc(msg.error));
    if (msg.stderr) {
      // 按**退出码**分档，不靠猜关键词：
      //   code === 0 → 这一轮是成功的，stderr 里多半是环境噪音
      //     （本机最常见的就是 pi 清理自己的 settings.json.lock 时，
      //      被安全策略拦下，于是它打一句 "Invalid settings file ..."）。
      //     成功的一轮拿红色 ERR 去砸用户，只会让人以为出大事了 ——
      //     这正是"用起来烧心"。降级成一条 SYS，全文留在 title 里可查。
      //   code !== 0 → 失败了，stderr 很可能就是失败原因，照实红着显示。
      const full = String(msg.stderr).trim();
      const first = full.split('\n').filter(Boolean)[0] || '';
      if (msg.code === 0) {
        const m = addMsg('step', 'SYS',
          '&gt; pi 本轮正常结束（退出码 0），但 stderr 有 ' +
          full.split('\n').filter(Boolean).length + ' 行输出：' + esc(first.slice(0, 140)));
        m.title = full.slice(0, 4000);   // 鼠标悬停可看全文，别丢信息
      } else {
        const m = addMsg('err', 'ERR', esc(full.slice(0, 600)));
        m.title = full.slice(0, 4000);
      }
    }
    endTurn(msg.code);
    return;
  }
  if (msg.kind !== 'ev') return;

  const ev = msg.ev;
  if (!ev || !ev.type) return;

  // pi 回显这一轮的 user 消息 —— 这里对账：发出去几张图，请求里真的进了几个。
  // 只有这一处能拿到"pi 实际发了什么"，所以判断放这儿，不放发送侧。
  if (ev.type === 'message_start' && ev.message && ev.message.role === 'user') {
    const info = inspectUserContent(ev.message.content);
    S.imgIn = info.imgs;
    if (info.omit) {
      if (!S.imgWarned) {
        S.imgWarned = true;
        addMsg('err', 'IMG', '图片没能进入请求：' +
          esc(IMG_OMIT_WHY[info.omit.key] || 'pi 把图片丢掉了') +
          (S.attSent ? '（本轮带了 ' + S.attSent + ' 张图）' : '') +
          (info.omit.text ? ' ｜ pi 原话：' + esc(info.omit.text) : ''));
      }
    } else if (S.attSent > 0 && info.imgs === 0) {
      // pi 既没放 image 块、也没留标记 —— 兜一层，别让它静静过去
      if (!S.imgWarned) {
        S.imgWarned = true;
        addMsg('err', 'IMG', '本轮带了 ' + S.attSent + ' 张图，但请求里一个图片块都没有 —— 图很可能没发出去。');
      }
    }
    return;
  }

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
      $('set-curmodel').textContent = (ev.message.provider || '') + '/' + ev.message.model;
      updateVision();
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

    // 子代理 / 嵌套调用 -> 右栏 AGENTS。
    // parentToolCallId 存在就说明这次调用是别的工具发起的（嵌套），
    // pi 会给这种调用分配 "<父 id>/<n>" 形式的 toolCallId。
    if (ev.toolName === 'subagent' || ev.parentToolCallId) {
      S.subs.push({
        id: ev.toolCallId,
        name: ev.toolName || '?',
        arg: briefOf(ev.args).slice(0, 120),
        nested: !!ev.parentToolCallId,
        state: 'running',
        at: Date.now()
      });
      renderSubs();
    }
    return;
  }

  // 工具真实执行结束：右栏 TOOLS 记一条（完整入参 + 真实输出）
  if (ev.type === 'tool_execution_end') {
    const p = S.pendingTool[ev.toolCallId] || {};
    const name = ev.toolName || p.name || '?';
    const args = (p.args !== undefined ? p.args : ev.args) || {};

    pushTool(name, briefOf(args), extractText(ev.result), JSON.stringify(args, null, 2));

    // todo 工具 -> 右栏 TODOS
    if (name === 'todo') {
      const t = todosFromToolResult(ev);
      if (t.known) { S.todos = t.list; renderTodos(); }
    }

    // 子代理收尾
    const si = S.subs.findIndex((x) => x.id === ev.toolCallId);
    if (si >= 0) {
      S.subs[si].state = ev.isError ? 'error' : 'done';
      S.subs[si].ms = Date.now() - S.subs[si].at;
      renderSubs();
    }

    delete S.pendingTool[ev.toolCallId];
  }
}
// 验收/调试入口：可以把真实事件流喂进来重跑渲染（test/verify-tools.js 用）
window.__pixelFeed = onMsg;
// 验收入口：导出 / 删除结果处理都要能**绕过需要人工点的对话框**单独调用。
// 它们各自绑着 system 保存框 / confirmBox，不抽出来就永远只能靠肉眼验。
window.__pixelExport = (seq, outPath, fmt) => exportSession({ seq: seq, title: '' }, outPath, fmt);
window.__pixelCfg = () => CFG;                                   // 验收脚本读当前生效的设置
window.__pixelApplyCfg = (c) => applyCfg(c);                     // 验收脚本直接灌一份设置看效果
// 按 seq 打开会话：走渲染层这条**真实**路径（不是裸调 IPC），
// 否则 S.seq 不会跟着变，后面 `/rename` 之类依赖"当前会话"的功能就测歪了。
window.__pixelOpenSession = (seq) => openSession(seq);
window.__pixelApplyDelete = (seq, res) => applyDeleteResult(seq, res);
// 「中断了几次」—— 只有可观测才验得动。
// 起因：设置面板开着时按 Esc，原来会掉进 doAbort() 把正在跑的这轮**中断掉**，
// 而面板还不关。doAbort 里有 `if (!S.busy) return`，测试时没在跑就什么都看不出来，
// 所以计数器必须放在 busy 判断**之前**，否则这条 bug 永远测不到。
window.__pixelAborts = 0;

if (api) api.onMsg(onMsg);

/* ============================================================
   左栏：会话列表 + 操作 + 搜索
   ============================================================ */
function sessionRow(r) {
  const d = el('div', 'sess' + (r.current ? ' on' : ''));
  const ops = el('span', 'sess-ops');

  const mk = (label, title, cls, fn) => {
    const b = el('button', 'sess-op' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  ops.appendChild(mk('改名', '重命名这个会话', '', () => renameSession(r)));
  ops.appendChild(mk('导出', '导出这个会话（格式在设置里选）', '', () => exportSession(r)));
  ops.appendChild(mk('删除', '删除（进回收站，可恢复）', 'del', () => deleteSession(r)));

  d.innerHTML =
    '<span class="sess-idx">#' + r.seq + '</span>' +
    '<span class="sess-main">' +
      '<span class="sess-name">' + esc(r.title) + '</span>' +
      '<span class="sess-meta">' + r.rounds + ' 轮 · ' + fmtClock(r.mtime) + (r.renamed ? ' · 已改名' : '') + '</span>' +
    '</span>';
  d.appendChild(ops);
  d.title = r.file;
  d.addEventListener('click', () => openSession(r.seq));
  return d;
}

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
  rows.forEach((r) => box.appendChild(sessionRow(r)));
}

function renderHits(hits, q) {
  const box = $('session-list');
  box.innerHTML = '';
  box.appendChild(el('div', 'search-hd', '搜索 “' + esc(q) + '” · ' + hits.length + ' 条命中'));
  if (!hits.length) {
    box.appendChild(el('div', 'sess',
      '<span class="sess-idx">--</span><span class="sess-main">' +
      '<span class="sess-name">没有命中</span>' +
      '<span class="sess-meta">换个关键词试试</span></span>'));
    return;
  }
  hits.forEach((h) => {
    const d = el('div', 'sess');
    d.innerHTML =
      '<span class="sess-idx">#' + h.seq + '</span>' +
      '<span class="sess-main">' +
        '<span class="sess-name">' + esc(h.title) + ' · ' + (h.role === 'user' ? '你' : 'PI') + '</span>' +
        '<span class="sess-snip">' + esc(h.snippet) + '</span>' +
      '</span>';
    d.title = '跳到会话 #' + h.seq + ' 第 ' + (h.idx + 1) + ' 条消息';
    d.addEventListener('click', () => {
      $('sess-q').value = '';
      $('sess-q-clear').classList.add('hidden');
      S.searchQ = '';
      openSession(h.seq);
    });
    box.appendChild(d);
  });
}

function updateCur(seq) {
  const e = $('tb-cur');
  if (e) e.textContent = '会话 #' + seq;
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
  S.todos = [];
  S.subs = [];
  renderTools(); renderTodos(); renderSubs();
  log.innerHTML = '';
  const h = await api.history(seq);
  if (!h || !h.msgs || !h.msgs.length) {
    addMsg('sys', 'SYS', '空会话。在下面输入开始对话。');
  } else {
    h.msgs.forEach((m) => {
      if (m.role === 'user') {
        addMsg('user', 'YOU', esc(m.text || '(只看图)'), m.images ? ('图×' + m.images) : null);
      } else {
        const b = addBotMsg();
        finishBotMsg(b.body, m.text, false);
      }
    });
    S.round = h.msgs.filter((m) => m.role === 'user').length;
    $('kv-round').textContent = String(S.round);
    // 待办也在会话文件里（工具结果的 details），切回来要恢复，不能丢
    if (h.todos && h.todos.length) { S.todos = h.todos; renderTodos(); }
    if (h.model) {
      $('kv-model').textContent = h.model;
      if (!S.curModel) $('kv-model2').textContent = h.model;
      updateVision();
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
  S.todos = [];
  S.subs = [];
  renderTools(); renderTodos(); renderSubs();
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
  updateVision();
  if (welcome) welcome.classList.remove('hidden');
  input.focus();
}

/* ---------- 会话操作 ---------- */
// 命名：三个入口共用这一条路 —— 会话条上的「重命名」按钮、`/rename`、`/rename 名字`。
// preset 给了就直接用（命令面板带参数），没给就弹框问。
async function renameSession(r, preset) {
  if (!api) return null;
  let name = preset;
  if (name == null) {
    name = await askInput('重命名()', r.renamed ? r.title : '',
      '留空 = 恢复成自动标题（跟别的会话重名会被拦下）');
    if (name == null) return null;                 // 取消
  }
  const res = await api.renameSession(r.seq, name);
  if (!res) return null;
  if (res.ok === false) {
    // 重名要**指名道姓**说清跟谁撞了，只回一句"失败"用户没法处理
    if (res.reason === 'NAME_TAKEN') {
      addMsg('err', 'ERR', '已经有会话叫「' + esc(res.name) + '」了（#' + res.clash + '），换个名字吧。');
    } else {
      addMsg('err', 'ERR', '改名失败：' + reasonZh(res.reason));
    }
    if (res.sessions) renderSessions(res.sessions);
    return res;
  }
  if (res.sessions) renderSessions(res.sessions);   // 改名要**立刻**反映到左栏
  addMsg('step', 'SYS', res.cleared
    ? '&gt; 会话 #' + r.seq + ' 已恢复成自动标题'
    : '&gt; 会话 #' + r.seq + ' 已改名为「' + esc(res.name) + '」');
  return res;
}

// `/rename [名字]`：拿的是**当前**会话（@ 后面那些路径的语义不同，别混）
async function renameCurrent(preset) {
  if (!api) return null;
  const all = await api.sessions();
  const row = (((all && all.sessions) || []).filter((s) => s.seq === S.seq))[0];
  if (!row) { addMsg('err', 'ERR', '找不到当前会话（可能还没有落盘），先发一句话再改名。'); return null; }
  return renameSession(row, preset);
}

async function deleteSession(r) {
  if (!api) return;
  const ok = await confirmBox(
    '删除()',
    '把会话 #' + r.seq + ' 删掉？\n\n「' + r.title + '」\n\n会进系统回收站（可恢复），不会直接抹掉。'
  );
  if (!ok) return;
  applyDeleteResult(r.seq, await api.deleteSession(r.seq));
}

// 把「删除结果」翻译成界面动作。
// 单独抽出来是为了可测：deleteSession 里那一步会先弹确认框，
// 自动化验收点不了它 —— 逻辑留在一个点不动的地方，就只能靠肉眼看了。
function applyDeleteResult(seq, res) {
  if (!res || res.ok === false) {
    addMsg('err', 'ERR', '删除失败：' + reasonZh(res && res.reason));
    return false;
  }
  if (res.sessions) renderSessions(res.sessions);
  // 回收站那一步报了异常、但文件确实已移出：说实话，别假装一切正常，
  // 也别谎报失败 —— 用户需要知道的是"可恢复性没确认"。
  if (res.trashNote) {
    addMsg('step', 'SYS', '&gt; 会话 #' + seq + ' 已从列表移除，但回收站操作报了异常（' +
      esc(res.trashNote) + '）—— 可恢复性未能确认。');
  }
  if (res.removedCurrent) {
    S.tools = []; S.todos = []; S.subs = [];
    renderTools(); renderTodos(); renderSubs();
    log.innerHTML = '';
    S.seq = res.current;
    updateCur(S.seq);
    if (welcome) welcome.classList.remove('hidden');
  }
  addMsg('step', 'SYS', '&gt; 会话 #' + seq + ' 已移入回收站');
  return true;
}

// outPath 可选：给了就跳过系统保存框直接写过去（自动化验收 / 脚本用）。
// 不给则弹框问用户 —— 界面按钮走的是这条路。
// fmt 可选：不传就用设置里的「导出格式」（html / md / json，三种都是真格式）
async function exportSession(r, outPath, fmt) {
  if (!api) return null;
  const format = fmt || (CFG && CFG.exportFormat) || 'html';
  const res = await api.exportSession(r.seq, outPath, format);
  if (res && res.ok) addMsg('step', 'SYS', '&gt; 已导出（' + esc(res.format || format) + '）：' + esc(res.out));
  else if (res && res.reason !== 'CANCELED') {
    addMsg('err', 'ERR', '导出失败：' + (res.error || reasonZh(res.reason)));
  }
  return res;
}

/* ---------- 搜索（防抖，别每敲一个字就扫一遍全部会话） ---------- */
if ($('sess-q')) {
  $('sess-q').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    S.searchQ = q;
    $('sess-q-clear').classList.toggle('hidden', !q);
    clearTimeout(S.searchTimer);
    if (!q) { refreshSessions(); return; }
    if (q.length < 2) { renderHits([], q); return; }
    S.searchTimer = setTimeout(async () => {
      if (!api) { renderHits([], q); return; }
      const r = await api.search(q);
      if (S.searchQ !== q) return;    // 结果回来时关键词已经变了就丢掉
      renderHits((r && r.hits) || [], q);
    }, 220);
  });
}
if ($('sess-q-clear')) {
  $('sess-q-clear').addEventListener('click', () => {
    $('sess-q').value = '';
    $('sess-q-clear').classList.add('hidden');
    S.searchQ = '';
    refreshSessions();
  });
}

/* ============================================================
   右栏：tab 切换 + TOOLS + TODOS + AGENTS + FILES
   ============================================================ */
document.querySelectorAll('.rtab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    ['tools', 'todos', 'files', 'sub'].forEach((t) => {
      $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
    });
    if (b.dataset.tab === 'files') loadFiles(S.fileDir || undefined);
    if (b.dataset.tab === 'sub') loadAgents();
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
    secIn.appendChild(el('span', 't-k', '入参'));
    secIn.appendChild(el('pre', null, esc(t.argsJson || '(无参数)')));
    const secOut = el('div', 't-sec');
    secOut.appendChild(el('span', 't-k', '返回'));
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

/* ---------- TODOS：真数据来自 pi 的 todo 工具（PixelAgent 自带扩展提供） ---------- */
function renderTodos() {
  const box = $('todos-list');
  const empty = $('todos-empty');
  const hd = $('todos-hd');
  if (!box) return;
  box.innerHTML = '';

  const list = S.todos || [];
  const done = list.filter((t) => t.done).length;
  if (hd) hd.textContent = list.length ? (done + ' / ' + list.length) : '—';

  if (!list.length) {
    empty.classList.remove('hidden');
    empty.textContent = '当前会话没有待办项';
    return;
  }
  empty.classList.add('hidden');

  list.forEach((t) => {
    const d = el('div', 'todo-item' + (t.done ? ' done' : ''));
    d.innerHTML =
      '<span class="todo-id">#' + esc(t.id) + '</span>' +
      '<span class="todo-cb">' + (t.done ? '☑' : '☐') + '</span>' +
      '<span class="todo-txt">' + esc(t.text) + '</span>';
    box.appendChild(d);
  });
}

/* ---------- AGENTS：会话内子代理活动 + 真扩展清单 ---------- */
function renderSubs() {
  const box = $('sub-list');
  const empty = $('sub-empty');
  if (!box) return;
  box.innerHTML = '';
  if (!S.subs.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  S.subs.forEach((s) => {
    const d = el('div', 'agent-item' + (s.state === 'running' ? ' live' : ''));
    d.innerHTML =
      '<span class="ag-n">' + esc(s.name) + (s.nested ? ' <span class="ag-tag">嵌套</span>' : '') + '</span>' +
      (s.arg ? '<span class="ag-p">' + esc(s.arg) + '</span>' : '') +
      '<span class="ag-tag">' +
        (s.state === 'running' ? '运行中' : s.state === 'error' ? '出错' : '完成') +
        (s.ms != null ? ' · ' + (s.ms / 1000).toFixed(1) + 's' : '') +
      '</span>';
    box.appendChild(d);
  });
}

function renderExts() {
  const box = $('ext-list');
  const empty = $('ext-empty');
  if (!box) return;
  box.innerHTML = '';
  const list = S.exts;
  if (!list) { empty.classList.remove('hidden'); empty.textContent = '读取中…'; return; }
  if (!list.length) {
    empty.classList.remove('hidden');
    empty.textContent = '隔离配置目录里还没装扩展（点上面 ↻ 重新读）';
    return;
  }
  empty.classList.add('hidden');
  list.forEach((x) => {
    const d = el('div', 'agent-item');
    d.innerHTML =
      '<span class="ag-n">' + esc(x.name) + '</span>' +
      (x.path ? '<span class="ag-p">' + esc(x.path) + '</span>' : '') +
      '<span class="ag-tag">' + esc(extSrcZh(x.source)) + '</span>';
    box.appendChild(d);
  });
}

let agentsLoading = false;
async function loadAgents() {
  if (!api || agentsLoading) return;
  agentsLoading = true;
  const r = await api.agents();
  agentsLoading = false;
  if (!r) return;
  S.exts = (r.extensions || []).concat(r.local || []);
  renderExts();
  if (r.ok === false) {
    const empty = $('ext-empty');
    if (empty && !S.exts.length) { empty.classList.remove('hidden'); empty.textContent = '读取失败：' + (r.error || '未知'); }
  }
}
if ($('btn-agents-refresh')) $('btn-agents-refresh').addEventListener('click', () => { S.exts = null; renderExts(); loadAgents(); });

/* ---------- FILES：可换工作目录 ---------- */
async function loadFiles(dir) {
  if (!api) { $('files-root').textContent = '(演示模式无文件树)'; return; }
  const r = await api.files(dir);
  S.fileDir = r.dir;
  S.fileCache = r.items || [];
  $('files-root').textContent = r.dir;
  $('files-root').title = r.dir;
  const box = $('files-list');
  box.innerHTML = '';
  if (r.parent) {
    const up = el('div', 'file-item dir');
    up.innerHTML = '<span class="f-ico">目录</span><span class="f-n">..</span>';
    up.addEventListener('click', () => loadFiles(r.parent));
    box.appendChild(up);
  }
  (r.items || []).forEach((it) => {
    const d = el('div', 'file-item' + (it.dir ? ' dir' : ''));
    d.innerHTML =
      '<span class="f-ico">' + (it.dir ? '目录' : '文件') + '</span>' +
      '<span class="f-n">' + esc(it.name) + '</span>' +
      '<span class="f-s">' + (it.dir ? '' : fmtBytes(it.size)) + '</span>';
    if (it.dir) d.addEventListener('click', () => loadFiles(it.path));
    box.appendChild(d);
  });
}
if ($('btn-refresh-files')) $('btn-refresh-files').addEventListener('click', () => loadFiles(S.fileDir));

async function pickDir() {
  if (!api) return;
  const r = await api.pickDir();
  if (!r || r.ok === false) {
    if (r && r.reason && r.reason !== 'CANCELED') addMsg('err', 'ERR', '换目录失败：' + (r.error || reasonZh(r.reason)));
    return;
  }
  S.fileDir = r.dir;
  S.fileCache = (r.files && r.files.items) || [];
  $('kv-cwd').textContent = r.dir;
  $('kv-cwd').title = r.dir;
  $('set-cwd').value = r.dir;
  await loadFiles(r.dir);
  addMsg('step', 'SYS', '&gt; 工作目录已切到 ' + esc(r.dir) + '（pi 的 cwd 和 @ 引用都跟着走）');
}
if ($('btn-pick-dir')) $('btn-pick-dir').addEventListener('click', pickDir);

/* ============================================================
   模型 / 思考档位选择器
   ============================================================ */
const TH_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// 档位显示成中文；传回 pi 的仍是上面的英文内部值（--thinking <lv>）
const TH_ZH = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

function modelLabel() {
  if (!S.curModel) return '默认';
  return S.curModel.model.length > 24 ? S.curModel.model.slice(0, 23) + '…' : S.curModel.model;
}
function paintModelBar() {
  $('kv-model2').textContent = modelLabel();
  $('kv-model2').title = S.curModel ? S.curModel.provider + '/' + S.curModel.model : '用 pi 自己的默认配置';
  $('kv-think').textContent = S.curThinking ? (TH_ZH[S.curThinking] || S.curThinking) : '默认';
  updateVision();
  renderAtt();     // 换了模型，附件条的「看不懂图」警告要跟着重算
}

function renderThinkBtns() {
  const box = $('mdl-think-btns');
  box.innerHTML = '';
  TH_LEVELS.forEach((lv) => {
    const on = (S.curThinking || '') === lv;
    const b = el('button', 'th-btn' + (on ? ' on' : ''), lv ? (TH_ZH[lv] || lv) : '默认');
    b.type = 'button';
    b.title = lv ? ('--thinking ' + lv + '（' + (TH_ZH[lv] || lv) + '）') : '用 pi 默认档位';
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
  // 标题带上条数（原来写死 `模型()`，一对空括号看着像坏了）。
  // 顺带把"一共多少 / 筛完剩多少"顶到标题栏 —— 列表要滚动时这是最省事的提示。
  $('mdl-title').textContent = '模型(' + rows.length + ')';
  if (!rows.length) { box.appendChild(el('div', 'empty', '没有匹配的模型')); return; }

  let curProv = null;
  rows.forEach((m) => {
    if (m.provider !== curProv) {
      curProv = m.provider;
      const n = rows.filter((x) => x.provider === m.provider).length;
      box.appendChild(el('div', 'mdl-prov', esc(m.provider) + '  ·  ' + n));
    }
    const on = S.curModel && S.curModel.provider === m.provider && S.curModel.model === m.model;
    const tags = [m.context, m.thinking ? '思考' : '', m.images ? '看图' : ''].filter(Boolean).join(' · ');
    const d = el('div', 'mdl-item' + (on ? ' on' : ''));
    d.innerHTML = '<span class="mi-n">' + esc(m.model) + '</span><span class="mi-tag">' + esc(tags) + '</span>';
    d.title = m.provider + '/' + m.model + ' · 上下文 ' + m.context + ' · 最大输出 ' + m.maxOut +
      (m.images ? ' · 支持看图' : ' · 不支持看图');
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
    $('mdl-count').textContent = '读取中…（正在运行 pi --list-models）';
    $('mdl-title').textContent = '模型(读取中)';
    const r = await api.models();
    if (r && r.ok && r.models && r.models.length) {
      S.models = r.models;
      S.modelsLoaded = true;
      if (r.current) { S.curModel = r.current.model; S.curThinking = r.current.thinking; }
    } else {
      $('mdl-count').textContent = '读取失败：' + ((r && r.error) || '未知原因');
      $('mdl-title').textContent = '模型(读取失败)';
      return;
    }
  }
  renderThinkBtns();
  renderModelList($('mdl-q').value);
  $('mdl-q').focus();
}

function closeModelPicker() { $('mask-model').classList.add('hidden'); }

/* ============================================================
   通用输入框 / 确认框
   Electron 里 window.prompt 和 window.confirm 都不可用（会被直接忽略），
   所以自己搭一个，Promise 化。
   ============================================================ */
let inpResolve = null;
let inpMode = 'input';

function openInputDialog(opts) {
  return new Promise((resolve) => {
    inpResolve = resolve;
    inpMode = opts.mode || 'input';
    $('inp-title').textContent = opts.title || '输入()';
    $('inp-tip').textContent = opts.tip || '回车确定，ESC 取消。';
    const f = $('inp-field');
    if (inpMode === 'confirm') {
      f.style.display = 'none';          // 确认框只需要是/否，不需要填东西
    } else {
      f.style.display = '';
      f.value = opts.value || '';
    }
    $('mask-input').classList.remove('hidden');
    setTimeout(() => { (inpMode === 'confirm' ? $('inp-ok') : f).focus(); }, 60);
  });
}

function closeInput(ok) {
  $('mask-input').classList.add('hidden');
  const r = inpResolve;
  const mode = inpMode;
  inpResolve = null;
  if (!r) return;
  if (mode === 'confirm') r(!!ok);
  else {
    const v = ok ? $('inp-field').value : null;
    $('inp-field').style.display = '';
    r(v);
  }
}

function askInput(title, value, tip) {
  return openInputDialog({ mode: 'input', title, value, tip });
}
function confirmBox(title, text) {
  return openInputDialog({ mode: 'confirm', title, tip: text });
}

if ($('inp-ok')) $('inp-ok').addEventListener('click', () => closeInput(true));
if ($('inp-cancel')) $('inp-cancel').addEventListener('click', () => closeInput(false));
if ($('inp-x')) $('inp-x').addEventListener('click', () => closeInput(false));
if ($('mask-input')) $('mask-input').addEventListener('click', (e) => { if (e.target === $('mask-input')) closeInput(false); });
if ($('inp-field')) {
  $('inp-field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeInput(true); }
    if (e.key === 'Escape') { e.preventDefault(); closeInput(false); }
  });
}

/* ============================================================
   命令面板（/ 开头）+ 文件引用（@ 开头）
   ------------------------------------------------------------
   一个成熟桌面端的命令面板该有的：模糊搜索 + 命中高亮、分组、最近使用、
   无结果提示、参数提示（`/rename 我的会话` 能连着写）。
   过滤/排序/渲染都收在这一段；键盘（↑↓ / Tab / Enter / ESC）在旁边那段。
   ★ 改过滤规则记得同时改 test/verify-palette.js 的反向验证用例。
   ============================================================ */
function switchTab(t) {
  const b = document.querySelector('.rtab[data-tab="' + t + '"]');
  if (b) b.click();
}

const COMMANDS = [
  { k: '/new',    g: '会话', d: '新建会话（清空上下文）',       run: () => newSession() },
  { k: '/rename', g: '会话', d: '给当前会话改名', arg: '名字',   run: (a) => renameCurrent(a) },
  { k: '/export', g: '会话', d: '导出当前会话（格式见设置）',   run: () => exportSession({ seq: S.seq, title: '当前会话' }) },
  { k: '/clear',  g: '会话', d: '清空当前视图（不动会话文件）', run: () => { log.innerHTML = ''; if (welcome) welcome.classList.remove('hidden'); } },
  { k: '/model',  g: '模型', d: '切换模型 / 思考档位',          run: () => openModelPicker() },
  { k: '/stop',   g: '运行', d: '停止当前这一轮',                run: () => doAbort() },
  { k: '/img',    g: '输入', d: '添加图片（也可直接粘贴/拖拽）', run: () => filePicker.click() },
  { k: '/dir',    g: '输入', d: '切换工作目录',                  run: () => pickDir() },
  { k: '/search', g: '导航', d: '跳到左栏搜索框',                run: () => { $('sess-q').focus(); } },
  { k: '/tools',  g: '视图', d: '打开右栏「工具」',            run: () => switchTab('tools') },
  { k: '/todos',  g: '视图', d: '打开右栏「待办」',            run: () => switchTab('todos') },
  { k: '/files',  g: '视图', d: '打开右栏「文件」',            run: () => switchTab('files') },
  { k: '/agents', g: '视图', d: '打开右栏「智能体」（看已装扩展）', run: () => switchTab('sub') },
  { k: '/settings', g: '视图', d: '打开设置（主题 / 输入 / 模型）', run: () => $('btn-settings').click() },
  { k: '/info',   g: '视图', d: '查看后端 / 会话运行信息',        run: () => $('btn-settings').click() }
];

const pal = { open: false, mode: '', items: [], idx: 0, empty: '' };

/* ---------- 最近使用（localStorage；这是使用痕迹，不是设置，不占配置文件） ---------- */
const PAL_RECENT_KEY = 'pixelagent.recentCmds';
function recentCmds() {
  try {
    const a = JSON.parse(localStorage.getItem(PAL_RECENT_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function pushRecent(k) {
  try {
    const list = recentCmds().filter((x) => x !== k);
    list.unshift(k);
    localStorage.setItem(PAL_RECENT_KEY, JSON.stringify(list.slice(0, 5)));
  } catch (e) { /* 存不了不该影响功能 */ }
}

/* ---------- 模糊匹配 / 高亮 / 排序都在 pal.js（纯逻辑，Node 里可断言） ----------
   这一层只负责把片段拼成 HTML —— 转义和拼标签必须在同一处做。 */
function segHtml(text, marks) {
  return Pal.segments(text, marks)
    .map((s) => (s.hit ? '<b class="pal-hit">' + esc(s.t) + '</b>' : esc(s.t)))
    .join('');
}

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
  // 无结果**不关面板**：关掉会让人以为自己没输进去，或者以为命令不存在
  if (!pal.items.length) {
    box.appendChild(el('div', 'pal-empty', pal.empty || '没有匹配的项'));
    $('pal-foot').textContent = '';
    return;
  }
  let last = '';
  pal.items.forEach((it, i) => {
    if (it.group && it.group !== last) {
      last = it.group;
      box.appendChild(el('div', 'pal-group', esc(it.group)));
    }
    const d = el('div', 'pal-item' + (i === pal.idx ? ' on' : ''));
    d.innerHTML = '<span class="pal-k">' + (it.labelHtml || esc(it.label)) + '</span>' +
                  '<span class="pal-d">' + esc(it.desc || '') + '</span>';
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      runPalItem(i);
    });
    box.appendChild(d);
  });
  // 参数提示：当前高亮项支持参数就在底部教一遍写法
  const cur = pal.items[pal.idx];
  $('pal-foot').textContent = (cur && cur.argTip) ? cur.argTip : '';
}

// 点/回车都走这里：记账「最近使用」→ 关面板 → 执行
function runPalItem(i) {
  const it = pal.items[i];
  const wasCmd = pal.mode === 'cmd';
  closePalette();
  if (wasCmd) { input.value = ''; syncCursor(); }
  if (!it) return;
  if (it.key && wasCmd) pushRecent(it.key);
  if (it.run) it.run();
}

/* ---------- 命令候选 ---------- */
function cmdItems(v) {
  return Pal.rankCommands(COMMANDS, v, recentCmds()).map((it) => ({
    label: it.label, labelHtml: segHtml(it.label, it.marks), desc: it.desc,
    group: it.group, argTip: it.argTip, key: it.key,
    // 用 key 反查命令（而不是在闭包里存引用）：命令表将来动了也不会指错
    run: () => {
      const c = COMMANDS.filter((x) => x.k === it.key)[0];
      if (!c) return;
      return (it.arg != null && it.arg !== '') ? c.run(it.arg) : c.run();
    }
  }));
}

function updatePalette() {
  const v = input.value;

  if (v.startsWith('/')) {
    pal.items = cmdItems(v);
    pal.empty = '没有这个命令。试试 /new、/model、/rename、/settings';
    if (!pal.open || pal.mode !== 'cmd') pal.idx = 0;   // 重新开始输入时回到第一条
    if (pal.idx >= pal.items.length) pal.idx = 0;
    openPalette('cmd', '命令');
    renderPalette();
    return;
  }

  // `!` 开头：直接执行，不进候选
  if (v.startsWith('!')) { closePalette(); return; }

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
    pal.empty = S.fileCache.length ? ('工作目录里没有匹配「' + v.slice(at + 1) + '」的文件') : '文件列表还没加载出来';
    // 文件列表都没加载出来就别弹空面板（比如消息里就写了个邮箱地址，@ 后面当然没文件）
    if (!pal.items.length && !S.fileCache.length) { closePalette(); return; }
    if (!pal.open || pal.mode !== 'file') pal.idx = 0;
    if (pal.idx >= pal.items.length) pal.idx = 0;
    openPalette('file', '引用文件');
    renderPalette();
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
    const n = pal.items.length;
    if (n && e.key === 'ArrowDown') { e.preventDefault(); pal.idx = (pal.idx + 1) % n; renderPalette(); return; }
    if (n && e.key === 'ArrowUp') { e.preventDefault(); pal.idx = (pal.idx - 1 + n) % n; renderPalette(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      // 命令面板开着但一条都没匹配上：**别把 /xyz 当聊天发出去**，
      // 也别静默什么都不做 —— 那两种情况用户都看不出发生了什么。
      if (!pal.items.length) {
        const wasCmd = pal.mode === 'cmd';
        const typed = input.value;
        closePalette();
        if (wasCmd) {
          input.value = ''; syncCursor();
          addMsg('err', 'ERR', '没有这个命令：' + esc(typed.trim()));
          return;
        }
        // 文件引用没匹配上不算"命令"：关掉面板后继续往下走，这一下 Enter 该发就发
      } else {
        runPalItem(pal.idx);
        return;
      }
    }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  }
  // Enter 的行为由设置决定：true=Enter 发送（Shift+Enter 换行）；
  // false=Enter 换行、Ctrl+Enter 发送。两种都在提示条里写清楚，别让用户猜。
  if (e.key === 'Enter') {
    const enterSends = !CFG || CFG.enterToSend !== false;
    if (enterSends ? !e.shiftKey : (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  }
  if (e.key === 'Escape') { e.preventDefault(); doAbort(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('mask-input').classList.contains('hidden')) { closeInput(false); return; }
    if (!$('mask-model').classList.contains('hidden')) { closeModelPicker(); return; }
    // ★ 设置面板这一支原来**漏了**：面板开着按 Esc 会一路掉到下面的 doAbort()，
    //   结果"想关掉设置"变成"把正在跑的这轮中断掉"，而且面板还开着。
    //   浮层谁开着就该谁吃掉 Esc —— 这里少写一行，代价是一个静默的误中断。
    if (!mask.classList.contains('hidden')) { closeSettings(true); return; }
    if (document.activeElement !== input) doAbort();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') { e.preventDefault(); openModelPicker(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('sess-q').focus(); }
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

/* ============================================================
   设置：真能改（界面 → .pixelagent.json → 重启还在）
   ------------------------------------------------------------
   规矩：界面上摆出来的每一个开关，都必须
     ① 在主进程 CFG_DEFAULTS 里有字段、有校验；
     ② 在下面 applyCfg / 各处使用点里**真的起作用**；
     ③ 能被 test/verify-settings.js 读回核对。
   摆了不生效的开关比没有这个开关更坏 —— 用户会以为是自己没点对。
   ============================================================ */
let CFG = null;        // 主进程回来的当前配置
let CFG_META = null;   // 主题色表 / 思考档位表（由主进程给，不在两处各写一份）
let cfgDraft = null;   // 面板里正在改的副本；取消要把预览整个回滚

function applyCfg(c, meta) {
  CFG = c || CFG || {};
  if (meta) CFG_META = meta;
  const acc = ((CFG_META && CFG_META.accents) || {})[CFG.accent];
  if (acc) {
    document.documentElement.style.setProperty('--lav', acc.main);
    document.documentElement.style.setProperty('--lav-deep', acc.deep);
  }
  document.body.classList.toggle('no-anim', CFG.mascotAnim === false);
  document.body.classList.toggle('compact', CFG.compact === true);
}

async function loadCfg() {
  if (!api) return;                      // 演示模式没有主进程，保持默认
  const r = await api.cfg();
  if (r && r.ok) applyCfg(r.cfg, { accents: r.accents, thinkingLevels: r.thinkingLevels, exportFormats: r.exportFormats });
}

function segOn(host, v) {
  if (!host) return null;
  const btns = host.querySelectorAll('.seg-b');
  for (const b of btns) {
    const hit = String(b.dataset.v) === String(v);
    b.classList.toggle('on', hit);
    if (hit) return b;
  }
  return btns[0] || null;
}
function segPick(host) {
  const b = host && host.querySelector('.seg-b.on');
  return b ? b.dataset.v : '';
}

// 主题色色块：由主进程的色表生成，不在 HTML 里写死
function buildAccentSeg() {
  const host = $('set-accent');
  if (!host) return;
  const table = (CFG_META && CFG_META.accents) || {};
  host.innerHTML = '';
  for (const k of Object.keys(table)) {
    const b = el('button', 'seg-b sw-b');
    b.type = 'button';
    b.dataset.v = k;
    b.title = table[k].name;
    b.style.background = table[k].main;
    b.addEventListener('click', () => { segOn(host, k); previewDraftCfg(); });
    host.appendChild(b);
  }
}

function cfgToForm(c) {
  if (!c) return;
  $('set-cwd').value = c.workDir || '';
  const msel = $('set-model');
  // 默认模型下拉：以真跑回来的模型目录为准；当前值不在目录里也补一条，免得被悄悄改掉
  const want = c.defaultModel || '';
  if (!msel.dataset.filled) {
    msel.innerHTML = '<option value="">（用 pi 默认）</option>';
    for (const m of (S.models || [])) {
      const o = el('option', null, esc(m.provider + '/' + m.model));
      o.value = m.provider + '/' + m.model;
      msel.appendChild(o);
    }
    msel.dataset.filled = '1';
  }
  if (want && !Array.prototype.some.call(msel.options, (o) => o.value === want)) {
    const o = el('option', null, esc(want));
    o.value = want;
    msel.appendChild(o);
  }
  msel.value = want;
  $('set-thinking').value = c.defaultThinking || '';
  $('set-maximg').value = String(c.maxImages == null ? 4 : c.maxImages);
  $('set-mascot').checked = c.mascotAnim !== false;
  $('set-compact').checked = c.compact === true;
  $('set-scroll').checked = c.autoScroll !== false;
  segOn($('set-enter'), c.enterToSend === false ? '0' : '1');
  segOn($('set-export'), c.exportFormat || 'html');
  segOn($('set-accent'), c.accent || 'lav');
}

function formToCfg() {
  return {
    workDir: $('set-cwd').value.trim(),
    defaultModel: $('set-model').value,
    defaultThinking: $('set-thinking').value,
    maxImages: Number($('set-maximg').value),
    mascotAnim: $('set-mascot').checked,
    compact: $('set-compact').checked,
    autoScroll: $('set-scroll').checked,
    enterToSend: segPick($('set-enter')) === '1',
    exportFormat: segPick($('set-export')) || 'html',
    accent: segPick($('set-accent')) || 'lav'
  };
}

// 主题色 / 动画 / 紧凑 这类"看得见"的先即时预览，取消时再整个回滚
function previewDraftCfg() {
  const d = formToCfg();
  applyCfg(Object.assign({}, CFG, { accent: d.accent, mascotAnim: d.mascotAnim, compact: d.compact }));
}

function setNote(text, bad) {
  const n = $('set-note');
  if (!n) return;
  n.textContent = text || '';
  n.classList.toggle('bad', !!bad);
}

async function openSettings() {
  mask.classList.remove('hidden');
  setNote('');
  // 标题里带上条目数：原来写死 `设置()`，空括号读起来像"坏了"。
  // 而且这个数字有用 —— 面板放不下要滚动（见 style.css 滚动条那段），
  // 标题先告诉用户"这里有 10 项"，比让人自己去发现底下还有东西强。
  $('set-title').textContent = '设置(' + document.querySelectorAll('.dialog-set .set-row').length + ' 项)';
  if (api) {
    const c = await api.cfg();
    if (c && c.ok) applyCfg(c.cfg, { accents: c.accents, thinkingLevels: c.thinkingLevels, exportFormats: c.exportFormats });
    // 模型目录：下拉要有真数据；没加载过就先拉一次（--list-models 冷启动慢，给个提示）
    if (!S.models.length) {
      $('set-model').innerHTML = '<option value="">（模型目录加载中…）</option>';
      $('set-model').dataset.filled = '';
      api.models().then((r) => {
        if (r && r.ok && r.models) { S.models = r.models; S.modelsLoaded = true; }
        $('set-model').dataset.filled = '';
        cfgToForm(CFG);
      }).catch(() => { $('set-model').dataset.filled = ''; cfgToForm(CFG); });
    }
    buildAccentSeg();
    cfgToForm(CFG);
  }
  fillRunInfo();
}

function closeSettings(revert) {
  if (revert && CFG) applyCfg(CFG);      // 回滚即时预览
  cfgDraft = null;
  mask.classList.add('hidden');
}

async function fillRunInfo() {
  if (!api) return;
  const i = await api.info();
  $('set-cli').textContent = i.cli || '未找到 pi 入口';
  $('set-session').textContent = i.session;
  $('set-mode').textContent = i.mode;
  $('set-agentdir').textContent = i.agentDir || '—';
  const st = i.agentDirState || {};
  $('set-auth').textContent = st.ready
    ? ('就绪' + (st.copied && st.copied.length ? '（首次已抄入 ' + st.copied.join('/') + '）' : ''))
    : ('未就绪：' + (st.error || '未知'));
  $('set-curmodel').textContent = i.current && i.current.model
    ? (i.current.model.provider + '/' + i.current.model.model)
    : (i.cli === null ? 'pi 未安装' : '（用 pi 默认）');
  $('kv-cwd').textContent = i.cwd || '—';
  $('kv-cwd').title = i.cwd || '';
}

$('btn-settings').addEventListener('click', () => openSettings());

$('set-cancel').addEventListener('click', () => closeSettings(true));
$('dlg-x').addEventListener('click', () => closeSettings(true));
mask.addEventListener('click', (e) => { if (e.target === mask) closeSettings(true); });

$('set-cwd-pick').addEventListener('click', async () => {
  if (!api) return;
  const r = await api.pickDir();
  if (!r || !r.ok) { if (r && r.reason !== 'CANCELED') setNote('选目录失败：' + (r.error || reasonZh(r.reason)), true); return; }
  $('set-cwd').value = r.dir;
  setNote('工作目录已切到 ' + r.dir + '（保存后生效）');
});

$('set-save').addEventListener('click', async () => {
  if (!api) return;
  const d = formToCfg();
  // 工作目录单独走 setWorkDir：它要校验目录真的存在，并顺手刷新文件树
  if (d.workDir && d.workDir !== (CFG.workDir || '')) {
    const r = await api.setWorkDir(d.workDir);
    if (!r || !r.ok) { setNote('工作目录没改成：' + reasonZh(r && r.reason), true); return; }
    CFG.workDir = r.dir;
    S.fileDir = r.dir;
    S.fileCache = (r.files && r.files.items) || [];
    $('kv-cwd').textContent = r.dir;
  }
  delete d.workDir;
  const res = await api.setCfg(d);
  if (!res || !res.ok) { setNote('保存失败：' + reasonZh(res && res.reason), true); return; }
  applyCfg(res.cfg, null);
  cfgToForm(CFG);
  // 主进程没认的键必须说出来：界面笔误（mascotAnim 写成 mascot）会表现成"点了没反应"
  if (res.droppedKeys && res.droppedKeys.length) {
    setNote('已保存，但有 ' + res.droppedKeys.length + ' 个键没认出来：' + res.droppedKeys.join('、'), true);
  } else {
    setNote('已保存到 .pixelagent.json，重启后依然生效');
  }
  if (api.models) api.models().then((r) => { if (r && r.ok && r.models) { S.models = r.models; S.modelsLoaded = true; $('set-model').dataset.filled = ''; cfgToForm(CFG); } }).catch(() => {});
});

$('set-reset').addEventListener('click', async () => {
  if (!api) return;
  const res = await api.resetCfg();
  if (!res || !res.ok) { setNote('恢复失败', true); return; }
  applyCfg(res.cfg, null);
  cfgToForm(CFG);
  setNote('已恢复默认（会话改名记录不受影响）');
});
// 面板里改"看得见"的项就即时预览
['set-mascot', 'set-compact'].forEach((id) => $(id).addEventListener('change', previewDraftCfg));

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
loadCfg();        // 先把设置读回来（主题色 / 紧凑 / 动画 / Enter 行为…），再画界面动作
renderTodos();
renderSubs();
renderExts();
loadAgents();     // 启动就预读扩展清单（主进程串行排队，不会跟模型目录抢锁）
setTimeout(() => input.focus(), 120);
refreshSessions();
if (api) {
  api.info().then((i) => {
    if (i && i.cwd) { $('kv-cwd').textContent = i.cwd; $('kv-cwd').title = i.cwd; }
  });
  api.files().then((r) => {
    if (r && r.items) { S.fileCache = r.items; S.fileDir = r.dir; }
  }).catch(() => {});
  // 启动就把模型目录拉下来：用量条要用上下文窗口当分母，
  // 视觉能力标记也要靠它判断（默认模型很可能看不懂图）。
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
      updateVision();
      // 模型目录到了 → 设置面板的"默认模型"下拉才有真数据，重建一次
      $('set-model').dataset.filled = '';
    }
  }).catch(() => {});
}

const q = new URLSearchParams(location.search);
if (q.get('auto')) {
  setTimeout(() => { input.value = q.get('auto'); syncCursor(); send(); }, 3000);
}
