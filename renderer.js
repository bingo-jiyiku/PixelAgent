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
// 老板 2026-10-11 17:44：「输入框就正常就好，不仿终端」
// 之前这里有 mirror（假光标位置测量）和 cursor（假光标元素）—— 现在都删了，
// 直接用浏览器原生光标。syncCursor() 变成 no-op 保留签名，因为下面十几处
// 调用点都是清完 input.value 后想同步光标位置，保留一个空函数最少改代码。
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
  // 像素性格预览去重（老板 2026-10-12）：设置面板里连点同一个性格只冒一次话
  personaPreviewed: '',
  tools: [],
  fileDir: '',
  fileCache: [],
  lastUser: '',       // 上一条用户输入（RETRY 用）
  models: [],         // 模型目录（真跑 pi --list-models 拿到）
  curModel: null,     // {provider, model} | null = 用 pi 默认
  curThinking: null,  // off..max | null = 用 pi 默认
  // pi 自己配置里的默认模型（读 ~/.pi/agent/settings.json，与终端 pi 同一份）。
  // 用途：没手动切过模型时 pi 报的 current.model 是 null，
  // 这时靠它把用量条的分母和"看图能力"补上，不然永远是 `— / —` 与 `图 ?`。
  piDefault: null,    // {provider, model} | null
  // 「实际跑出来的模型」—— pi 的 turn_end 事件里带回来的那个。
  // 和 piDefault 的区别：piDefault 是**配置里写的**，这个是**真跑了的**。
  // 没手动切过模型时两者可能不一样（比如配置写 auto、实际落到了别处），
  // 显示时以"真跑了的"为准，因为它才是用户该关心的那个。
  observedModel: null,
  observedProvider: null,
  collapsedProvs: null,  // 模型列表里被收起服务商（Set，持久化在 localStorage）
  modelsLoaded: false,
  pendingTool: {},    // toolCallId -> {name, args}：args 只在 start 事件里有
  attachments: [],    // 待发送的图片附件
  attLoading: 0,      // 正在读取中的图片张数（算上限时要算上，否则连拖 10 张会全进来）
  attSent: 0,         // 这一轮实际发出去几张图（用来对账"图到底进没进请求"）
  imgIn: 0,           // pi 回显的 user 消息里真的有几个 image 块
  imgWarned: false,   // 这一轮已经就图片问题提过醒，别重复刷屏
  todos: [],          // 真 todo 工具吐出来的待办
  subs: [],           // 会话内子代理/嵌套调用活动
  // 老板 2026-10-13：「后台有任务的话我希望可以显示在右上角智能体栏目里面并显示数量」——
  // 主进程登记（pi 轮次 / `!` 命令）后整表推过来，这里只存快照负责画。
  bg: [],             // [{id, kind, label, state, at}]
  // 缓存命中（老板 2026-10-13：「加个缓存命中到最下方栏」）：
  // 最近一轮的 {hit, read, write, input}；null = 还没有用量数据。
  cache: null,
  // 桌面提醒发送记录（验收读这个，见 desktopNotify 的注释）
  notifyLog: [],
  exts: null,         // 已装扩展（真跑 pi list）
  extUpd: {},         // 本次会话更新成功的扩展（pkgId -> 时间戳）：渲染成「最新 ✓」
  extOutdated: null,  // 启动时自动检查的待更新包名集合（null = 还没查完）
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
// 字节数 —— 这个**故意**和下面的 fmtTokens 不是一个进制：文件大小按 1024 天经地义，
// 而 token 数要跟 pi 的模型表（÷1000）对齐，否则同一个模型会冒出两个数。
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}
// 1.0M → 1M、262.1K 原样（跟 pi 模型表里的写法对齐，少一位视觉噪音）
function trimZero(s) { return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, ''); }
// ★ 进制必须和 main.js 的 parseSize、以及 **pi 自己**一致：都按 1000。
//   pi 的 formatTokenCount 是 ÷1000，所以表里的 `128K` 就是 128000。
//   历史上这里和 parseSize 都按 1024，结果是同一个模型出现两个数：
//   pi 表写 `128K`、用量条写 `131.1K`、配置框写 `131072 词元` ——
//   三个数看着像三件事，而"上下文到底是多少"就成了没法回答的问题。
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return trimZero((n / 1000000).toFixed(2)) + 'M';
  if (n >= 1000) return trimZero((n / 1000).toFixed(1)) + 'K';
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
// 瞬时提示条。**不能**用 addMsg 代替：addMsg 会 showTimeline()，
// 而"回主页 + 提示删掉了"这两件事在时间线里是互斥的（见 applyDeleteResult）。
let toastTimer = null;
function toast(text, kind) {
  const box = $('toast');
  if (!box || !text) return;
  box.textContent = text;
  box.className = 'toast' + (kind ? ' ' + kind : '');   // 去掉 hidden
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.classList.add('hidden'); }, 2600);
}
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

// token 消耗累计（老板 2026-10-11：吉祥物屏幕上多一行 token 消耗）
// 没有精确计费口，先用「字符数/2」估算（中英混合口径），够看趋势用
let tokenEst = 0;
// 点电脑时把 token 折成钱的估算单价（元 / 千 token）——
// 拍的是豆包 coding 档的综合价，没有真实账单口，只看量级；老板说改就改
const TOKEN_EST_RATE = 0.015;
function bumpTok(n) {
  if (!n) return;
  tokenEst += Math.max(1, Math.ceil(n / 2));
  const t = document.getElementById('of-token');
  if (t) t.textContent = tokenEst >= 1000 ? (tokenEst / 1000).toFixed(1) + 'K' : String(tokenEst);
}

function addMsg(cls, who, txt, extra) {
  showTimeline();
  if (txt && /me|user|人/i.test(who || '')) bumpTok(txt.length);
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
  bumpTok((text || '').length);
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

/* ---------- 状态灯 + 像素女孩状态联动 + 吉祥物说话 ---------- */
// 显示用中文；dataset.status / dataset.state 仍是英文内部值（CSS 动画选择器依赖）
const STATE_ZH = { IDLE: '空闲', THINKING: '思考中', TOOL: '处理中', DONE: '完成' };
const CAP_ZH = { THINKING: '思考中…', TOOL: '处理中…', DONE: '完成！', IDLE: '待机' };

// 吉祥物「说话」：头顶冒文字气泡。老板 2026-10-11 明确不要 TTS 语音，
// 走的是文字气泡。词库按四态 + 分区点击分：
//   - IDLE / THINKING / TOOL / DONE：状态自动切换时随机冒
//   - CLICK：通用点击（点空白、点桌子、点书架）
//   - GIRL：点人物本体
//   - MONITOR：点显示器（换代码片段，冒编程相关的话）
//   - KEYBOARD：点键盘（打字爆发，冒敲代码相关的话）
//   - MUG：点马克杯（☕）
// 词库刻意简短（≤10 字），因为气泡宽 80px —— 长句要么撑破要么截断。
// 老板 2026-10-11 20:30 删了 MONITOR → 19:41 加回来："要坐着要有之前那个电脑啊"
// 老板 2026-10-12：加「像素性格」—— GIRL_LINES = 活泼（默认）+ 兜底，
//   PERSONA_LINES 是另外三种性格，pickLine 按设置里的 persona 选。
const GIRL_LINES = {
  IDLE:       ['嗨~', '在的', '等你', '…', '☕', '我叫像素'],
  THINKING:   ['想想…', '嗯…', '让我看看', '在跑…', '琢磨中'],
  TOOL:       ['噼啪~', '敲代码…', '稍等', '写代码…', '噼里啪啦'],
  DONE:       ['好！', '搞定~', '✓', 'OK~'],
  CLICK:      ['嗨~', '在的', '有事吗', '…', '我叫像素'],
  GIRL:       ['嗨~', '在的', '怎么啦', '…', '我叫像素'],
  MONITOR:    ['看代码…', '写着呢', 'bug?', '调试中…', '编译…'],
  KEYBOARD:   ['噼啪~', '敲代码…', '噼里啪啦', 'Ctrl+C', 'Tab→'],
  MUG:        ['☕', '来杯？', '续命水', '咖啡因+1']
};

// 像素性格词库（老板 2026-10-12：「给像素做一个性格进去」）。
// 每套覆盖全部 9 类，缺的类兜底回 GIRL_LINES（见 pickLine）。
const PERSONA_LINES = {
  // 高冷：话少、句号多、不废话
  cool: {
    IDLE:     ['嗯。', '在。', '说。', '…', '。', '没空。'],
    THINKING: ['…思考中。', '别催。', '嗯…', '等着。', '看呢。'],
    TOOL:     ['忙。', '处理中。', '代码…', '啧，又改？', '忙着呢。'],
    DONE:     ['完事。', '可以了。', '✓', '哼，简单。'],
    CLICK:    ['嗯？', '说。', '…', '在听。'],
    GIRL:     ['干嘛。', '说。', '…', '我在。'],
    MONITOR:  ['看代码。', '写着。', '有 bug。', '编译中…', '别碰。'],
    KEYBOARD: ['噼啪。', '敲代码。', '…', 'Ctrl+C', 'Tab→'],
    MUG:      ['☕', '嗯，续命。', '咖啡因+1', '来杯。']
  },
  // 毒舌：损但不下作，自嘲式吐槽
  sharp: {
    IDLE:     ['又叫咱？', '在呢~', '啥事', '…', '☕先来一口', '说重点'],
    THINKING: ['脑细胞燃烧中', '让我瞅瞅', '在跑…', '别催', '想想…'],
    TOOL:     ['干呢~', '忙着呢', '写代码…', '稍等', '噼啪~'],
    DONE:     ['简简单单', '搞定~', '✓', 'OK~', '就这？'],
    CLICK:    ['在呢', '又叫咱？', '啥事', '…', '嗯嗯'],
    GIRL:     ['夸我？', '在呢~', '怎么啦', '…', '我在呢'],
    MONITOR:  ['这代码…', '写着呢', 'bug 在哪', '调试中…', '编译…'],
    KEYBOARD: ['噼啪~', '敲代码…', '噼里啪啦', 'Ctrl+C', 'Tab→'],
    MUG:      ['☕', '来杯？', '续命水', '咖啡因+1']
  },
  // 温柔：软语气、陪伴感
  warm: {
    IDLE:     ['在的呀', '陪你呢', '等你说', '…', '☀', '慢慢来'],
    THINKING: ['想一想…', '嗯…', '让我看看', '在跑…', '不着急'],
    TOOL:     ['在做呢~', '稍等一下', '写代码…', '马上好', '噼啪~'],
    DONE:     ['好啦~', '完成啦', '✓', '辛苦啦', '抱一下'],
    CLICK:    ['在的呀', '陪你呢', '有事吗', '…', '嗯嗯'],
    GIRL:     ['怎么啦', '在的呀', '…', '我在呢~'],
    MONITOR:  ['看代码…', '写着呢', 'bug 没关系', '调试中…', '编译…'],
    KEYBOARD: ['噼啪~', '敲代码…', '噼里啪啦', 'Ctrl+C', 'Tab→'],
    MUG:      ['☕', '来杯？', '续命水', '温温的']
  }
};

// 显示器代码片段库：点显示器时循环切换
// 每片段 4 行，用短横线长度代表"代码行宽"，视觉更像真实代码。
const MONITOR_SNIPPETS = [
  [34, 26, 44, 28],  // 片段 1
  [20, 40, 32, 46],  // 片段 2
  [44, 17, 36, 22],  // 片段 3
  [28, 42, 20, 37]   // 片段 4
];

// 上一次触发气泡的时间戳（毫秒）—— 用来决定"这次要不要打断上一条"。
// 用户连续点击时想让人看到最新的；状态自动切换时若离上一条很近，就覆盖。
let girlSayAt = 0;
let girlSayTimer = null;
let girlSaySticky = false;   // 粘性气泡挂着时为 true：状态闲聊不盖它（见 girlSay）

// 吉祥物"说话"。第三个参数 onClick 可选（老板 2026-10-12：
// "检查更新的提醒我希望是由像素那边说出来提醒"）—— 带上它气泡就可点，
// 点了执行回调并收起（例如打开下载页）。没带就跟以前一样纯展示。
function girlSay(text, ms, onClick, sticky) {
  const b = $('of-bubble-txt');
  if (!b) return;
  if (!text) {
    b.classList.remove('on');
    b.onclick = null;
    b.style.pointerEvents = '';
    b.style.cursor = '';
    girlSaySticky = false;
    if (girlSayTimer) { clearTimeout(girlSayTimer); girlSayTimer = null; }
    return;
  }
  b.textContent = text;
  b.classList.add('on');
  // 可点气泡：启用指针事件 + 手型；点击 stopPropagation ——
  // 否则会顺着 girl-scene 的监听被判成"点空白区"弹一句招呼，把正事盖掉。
  b.onclick = onClick
    ? (function (ev) {
        ev.stopPropagation();
        girlSay('');            // 先收起，避免回调打开新窗口后气泡还挂着
        onClick();
      })
    : null;
  b.style.pointerEvents = onClick ? 'auto' : '';
  b.style.cursor = onClick ? 'pointer' : '';
  girlSayAt = Date.now();
  if (girlSayTimer) clearTimeout(girlSayTimer);
  // 粘性气泡（目前只有更新提醒用）：挂着的时候，状态切换的闲聊不许盖它
  // （老板 2026-10-12 23:xx：「启动了不会主动告诉用户有新更新」——根因就是
  //  更新气泡和启动招呼/状态闲聊抢同一个气泡位，后到者赢，更新消息被换掉
  //  或被招呼的 3 秒计时器提前收掉）。点击收起和显式 girlSay('') 都会解除粘性。
  girlSaySticky = !!sticky;
  if (ms > 0) girlSayTimer = setTimeout(() => girlSay(''), ms);
}

// 桌面提醒（老板 2026-10-13：「还要有桌面提醒功能」）—— 系统级 Notification。
// 三条规矩缺一不可：
//   ① 设置里能关（CFG.desktopNotify，默认开）—— 不摆"只显示不生效"的假设置；
//   ② **窗口在前台时绝不弹**：前台弹通知是纯骚扰。老板的场景就是"切去看别的窗口"，
//      所以判据是 document.hasFocus()（渲染进程才是唯一知道焦点的）；
//   ③ 失败静默 —— 通知是锦上添花，api.notify 抛了也不能反过来砸用户的脚。
// 渲染进程没有 new Notification 的权限（contextIsolation），必须走主进程 IPC。
// 每发一封都往 S.notifyLog 记一笔：验收读它来判断"该发的时候发没发"——
// 不靠拦 window.pixelAPI.notify（contextBridge 暴露的对象属性改不动，
// 硬改只会让测试自己假红，2026-10-13 实测过）。
function desktopNotify(title, body) {
  if (CFG && CFG.desktopNotify === false) return;
  if (typeof document !== 'undefined' && document.hasFocus && document.hasFocus()) return;
  if (!api || !api.notify) return;
  S.notifyLog.push({ title: String(title || ''), body: String(body || ''), at: Date.now() });
  try { api.notify(title, body).catch(() => {}); } catch (e) { /* 静默 */ }
}

// 有新版本时像素主动开口（老板 2026-10-12 23:xx：「我刚刚启动了像素，
// 不会主动告诉用户有新更新啊」）。两条通道：
//   ① 像素气泡：30 秒 + **粘性**——启动招呼和状态闲聊不许盖它（见 girlSay
//      的 sticky 参数；根因就是这些闲聊和更新气泡抢同一个气泡位，后到者赢，
//      更新消息被换掉或被招呼的 3 秒计时器提前收掉）。点了直接开下载页。
//   ② 状态栏徽章：常驻，气泡收起了也随时能点。
// 抽成具名函数是为了让验收能喂**真实形状**的返回（{ok,hasUpdate,latest}）——
// 以前的断言是直接调 girlSay 模拟，IPC→handler→这条真实链路反而没被覆盖过。
const UPDATE_BUBBLE_MS = 30000;          // 气泡挂多久（够看完、不至于赖着不走）
const UPDATE_REMIND_EVERY_MS = 10 * 60 * 1000;   // 没更新就每 10 分钟再提一次
let updateLoop = null;
let updateLatest = '';

function showUpdateReminder(r, api) {
  if (!r || !r.ok || !r.hasUpdate) return false;
  const latest = String(r.latest || '');
  updateLatest = latest;
  girlSay('发现新版本 ' + latest + '，点我去更新', UPDATE_BUBBLE_MS, () => {
    if (api && api.openUpdatePage) api.openUpdatePage();
  }, true);
  const badge = $('sb-update');
  if (badge) {
    const ver = $('sb-update-ver');
    if (ver) ver.textContent = latest;
    badge.classList.remove('hidden');
    badge.onclick = () => { if (api && api.openUpdatePage) api.openUpdatePage(); };
  }
  // 老板 2026-10-13：「还要有桌面提醒功能」—— 窗口不在前台时，系统通知也报一份
  desktopNotify('PixelAgent 发现新版本 ' + latest, '点开应用去更新；或点状态栏的「⬆ 新版」去下载页');
  return true;
}

// 收摊：确认没有待更新（或用户已经更新过）—— 停周期、收徽章、（挂着的是更新气泡就）收气泡。
function stopUpdateReminder() {
  if (updateLoop) { clearInterval(updateLoop); updateLoop = null; }
  const badge = $('sb-update');
  if (badge) badge.classList.add('hidden');
  // 只有更新气泡是粘性的（见 girlSay 的 sticky），所以这里能安全地按粘性判断
  if (girlSaySticky) girlSay('');
}

// ★ 老板 2026-10-12 23:5x：「我希望用户没更新时，像素会时不时的就气泡提醒用户，
//   而不是启动提醒一次就没了」——启动那次之外，再加一条周期复检：有新版本就再冒一次泡；
//   确认已经是最新就收摊，别一直骚扰。
//   为什么周期里要 **force 重查**（而不是复用启动那次的结果）：
//   主进程的 app:check-update 带缓存（updateCache），**启动时没网 ⇒ 缓存里就是 ok:false，
//   这一整轮会话再也查不出更新** —— 周期重查正好把这个缺口补上：装了新版本/新发版
//   能在最迟 10 分钟后的复检里被发现。
//   everyMs 可传小值 —— 验收脚本靠它把 10 分钟压成几百毫秒，不用真等。
function startUpdateReminderLoop(api, everyMs) {
  if (updateLoop) clearInterval(updateLoop);
  const period = everyMs > 0 ? everyMs : UPDATE_REMIND_EVERY_MS;
  updateLoop = setInterval(() => {
    if (!api || !api.checkAppUpdate) return;
    api.checkAppUpdate(true).then((r) => {
      if (!r || !r.ok) return;               // 这轮没网/超时：不打扰，也不收摊（下轮再试）
      if (!r.hasUpdate) { stopUpdateReminder(); return; }
      showUpdateReminder(r, api);            // 还有新版本：再提醒一次
    }).catch(() => { /* 静默：提醒失败绝不能反过来烦人 */ });
  }, period);
}

// 启动那一次检查 + 决定要不要起周期。抽成具名函数是为了让验收能喂假 api
// 把这张**决策表**整条验掉 —— 否则"周期逻辑写对了、但启动时根本没调它"
// 这种错在验收里是绿的（三处接线漏一处，症状是"提醒再也不出现"）。
//   查成了且有新版本 → 冒泡 + 起周期
//   查成了且已是最新   → 收摊（不起周期，绝不打扰）
//   没查成（没网/超时）→ 不起泡但**要起周期**：主进程那份结果是带缓存的，
//                        启动没网会把 ok:false 焊在缓存里，只有周期里的 force 重查能救回来
function bootstrapUpdateCheck(api) {
  api.checkAppUpdate().then((r) => {
    if (r && r.ok && !r.hasUpdate) { stopUpdateReminder(); return; }
    showUpdateReminder(r, api);
    startUpdateReminderLoop(api);
  }).catch(() => { startUpdateReminderLoop(api); });
}

function pickLine(kind) {
  // 按像素性格选词库（老板 2026-10-12）：活泼=lively=GIRL_LINES 本身；
  // cool/sharp/warm 走 PERSONA_LINES，缺类兜底回 GIRL_LINES。
  const p = (CFG && CFG.persona) || 'lively';
  const table = (p !== 'lively' && PERSONA_LINES[p]) ? PERSONA_LINES[p] : GIRL_LINES;
  const list = table[kind] || GIRL_LINES[kind] || GIRL_LINES.IDLE;
  return list[(Math.random() * list.length) | 0];
}

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
  const cap = $('girl-cap');  // 老板 2026-10-11：底部状态标签删了，状态灯 sb-state 已经够用
  if (girl) girl.dataset.state = state;
  if (scene) scene.dataset.state = state;
  if (cap) cap.textContent = CAP_ZH[state] || state;

  // 状态切换时冒一句话（工作态时长 2.5s 让它跟动画节奏匹配，
  // 完成态 2s 更干脆，空闲态 3s 悠一点）。
  // 用户主动点击触发的话（下面 attachGirlClick）会自己覆盖。
  // 粘性气泡（更新提醒）挂着时，IDLE/THINKING/TOOL 的闲聊不许盖它——
  // 老板 2026-10-12：「启动了不会主动告诉用户有新更新」，根因就是这些闲聊
  // 和更新气泡抢同一个位置。DONE 放行：一轮干完的反馈比提醒 nag 重要，
  // 而且盖了之后状态栏徽章还在，更新信息不丢。
  const durByState = { IDLE: 3000, THINKING: 2500, TOOL: 2500, DONE: 2000 };
  if (!(girlSaySticky && state !== 'DONE')) girlSay(pickLine(state), durByState[state] || 2500);
}

/* 点击分区互动 —— 老板 2026-10-11 18:54「点击可交互的」
   绑在 .girl-scene（整个场景），通过 e.target 判断点的是哪个分区：
     .of-girl      → 点头 + 招呼气泡
     .of-monitor   → 点头 + 切换代码片段 + 编程话（19:41 加回来）
     .of-keyboard  → 点头 + 打字爆发（键盘键快闪） + 敲代码话
     .of-mug       → 点头 + ☕ 气泡
     其余（墙、桌、书架、盆栽） → 点头 + 通用招呼气泡
   连续点击时 girlSay 会用最新 timer 覆盖旧的。
   点人物本体的时候，e.target 可能是 .of-girl 本身，也可能是 img 元素
   （img 在 .of-girl 里，但 click 事件的 target 就是 img）—— 用 closest 判。 */
function attachGirlClick() {
  const scene = $('girl-scene');
  if (!scene) return;
  scene.addEventListener('click', (e) => {
    if (!scene.contains(e.target)) return;

    const girl = $('pixel-girl');
    if (!girl) return;

    /* 老板 2026-10-11：不要随便点一个地方就交互。
       热区白名单：像素 / 电脑 / 键盘 / 窗户 / 水杯 —— 点空白处没反应。 */
    const t = e.target;
    let zone = null;
    if (t.closest && t.closest('.of-girl')) zone = 'GIRL';
    else if (t.closest && t.closest('.of-monitor')) zone = 'MONITOR';
    else if (t.closest && t.closest('.of-keyboard')) zone = 'KEYBOARD';
    else if (t.closest && t.closest('.of-mug')) zone = 'MUG';
    else if (t.closest && t.closest('.of-window')) zone = 'WINDOW';
    if (!zone) return; // 热区以外：完全不理

    // 分区专属内容
    let say = pickLine(zone === 'WINDOW' ? 'CLICK' : zone);
    if (zone === 'MONITOR') {
      // 点电脑：报 token 消耗 + 估算花费（估算口径见 TOKEN_EST_RATE）
      if (tokenEst > 0) {
        say = '累计用了 ' + (tokenEst >= 1000 ? (tokenEst / 1000).toFixed(1) + 'K' : tokenEst) +
              ' token，约 ¥' + ((tokenEst * TOKEN_EST_RATE) / 1000).toFixed(2) + ' 哦~';
      } else {
        say = '还没开始消耗 token 哦';
      }
      triggerMonitorCycle();
    } else if (zone === 'WINDOW') {
      // 点窗户：报时间 + 时段问候
      const d = new Date();
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const seg = timeSeg(d.getHours());
      const greet = { morning: '早上好', noon: '中午好', afternoon: '下午好', evening: '晚上好', night: '夜深了，早点休息' }[seg];
      say = '现在 ' + hm + '，' + greet + '~';
    } else if (zone === 'KEYBOARD') {
      triggerTypingBurst();
    }

    girlSay(say, 2600);

    // 点头动画（吉祥物"回应"了）
    girl.classList.remove('girl-nod');
    void girl.offsetWidth;
    girl.classList.add('girl-nod');
    setTimeout(() => girl.classList.remove('girl-nod'), 700);
  });
}

/* 显示器代码片段循环：点击显示器时切换到下一个片段
   片段切换通过 CSS variable --cl-w 控制每行代码的宽度
   （CSS 里 .of-cl 的 width 从 0 动画到 var(--cl-w)） */
let monitorSnipIdx = 0;
function triggerMonitorCycle() {
  monitorSnipIdx = (monitorSnipIdx + 1) % MONITOR_SNIPPETS.length;
  const snip = MONITOR_SNIPPETS[monitorSnipIdx];
  const clEls = document.querySelectorAll('.of-cl');
  clEls.forEach((el, i) => {
    el.style.setProperty('--cl-w', (snip[i] || 30) + 'px');
  });
  // 顺便让代码重新播放打字动画（强制 reflow 重启 animation）
  const code = document.querySelector('.of-code');
  if (code) { void code.offsetWidth; }
}

/* 键盘打字爆发：点击键盘时让所有键快闪 3 次
   给每个键加 .typing-burst 类，400ms 后移除 */
let typingBurstTimer = null;
function triggerTypingBurst() {
  const keys = document.querySelectorAll('.of-keyboard i');
  keys.forEach(k => k.classList.add('typing-burst'));
  if (typingBurstTimer) clearTimeout(typingBurstTimer);
  typingBurstTimer = setTimeout(() => {
    keys.forEach(k => k.classList.remove('typing-burst'));
  }, 400);
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

/* ---------- 输入行光标 ---------- */
// 老板 2026-10-11 17:44：「输入框就正常就好，不仿终端」
// 之前 syncCursor 里用 #mirror 量宽度、再挪 #cursor 方块光标的位置。
// 现在直接用浏览器原生 caret（caret-color 已改成默认色，见 style.css）。
// syncCursor() 保留成 no-op，因为下面十几处调用点（清 input.value 后触发光标同步）
// 都是这个语义；留着 no-op 比改十几处少出错。
function syncCursor() { /* no-op：现在靠浏览器原生光标，不用手动同步 */ }
input.addEventListener('input', () => { updatePalette(); });

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
   ------------------------------------------------------------
   ★ 关于那个分母（老板问过"上下文怎么只有十万，是你定的还是模型定的"）：
   答案是**第三种** —— 它不是模型说的、也不是我们定的，而是 **pi 的模型表第 3 列**。
   实测 `pi --list-models` 的 130 行里，第 3 列只出现过
     1M / 1.0M / 1.1M / 524.3K / 512K / 500K / 400K / 272K / 262.1K / 256K / 204.8K / 200K / 128K
   —— **根本没有 10 万**。而默认模型 `ark-code-latest` 在 `~/.pi/agent/models.json`
   里只有 `{"id":"ark-code-latest"}`，**一个 contextWindow 都没声明**，
   所以 pi 退回了自己的兜底常量（在 pi 的 bundle 里能翻到 `contextWindow??128e3`）。
   两件事因此落地：
     ① 用量条能**点开看来源**（下面 showUsageDetail），别让人再猜；
     ② 模型配置框里可以**覆盖**这个值（`modelOverrides`），并且会标出来源。
   ============================================================ */
// 当前**生效**的模型：pi 报的当前模型；没报就用 pi 自己配置的默认模型。
// 为什么要有后半句：实测没手动切过模型时 pi 返回 `current.model = null`，
// 于是分母查不到，用量条永远是 `— / —`，用户会以为这功能没做。
function effModel() {
  if (S.curModel && S.curModel.model) return { provider: S.curModel.provider, model: S.curModel.model };
  if (S.piDefault && S.piDefault.model) return { provider: S.piDefault.provider, model: S.piDefault.model };
  return null;
}
function overrideOfUI(provider, model) {
  const map = (CFG && CFG.modelOverrides) || {};
  return map[String(provider || '') + '/' + String(model || '')] || null;
}
// 分母从哪来：override（我们覆盖的）> pi（模型表给的）> unknown
// `text` 是**表里的原话**（"1.0M" 就存 "1.0M"），显示时优先用它 ——
// 这样"pi 表里那个数"和"用量条上那个数"永远对得上，不会差一位小数。
function ctxInfoOf(provider, model) {
  if (!model) return { tokens: 0, source: 'unknown', text: '' };
  const ov = overrideOfUI(provider, model);
  if (ov && ov.contextTokens) return { tokens: ov.contextTokens, source: 'override', text: '' };
  const hit = S.models.find((m) => m.model === model && (!provider || m.provider === provider));
  if (hit && hit.contextTokens) return { tokens: hit.contextTokens, source: 'pi', text: hit.context || '' };
  return { tokens: 0, source: 'unknown', text: '' };
}
// 分母的**显示文案**：有表里的原话就用原话，否则自己格式化。
function ctxLabel(ci) {
  if (!ci || !ci.tokens) return '—';
  return ci.text || fmtTokens(ci.tokens);
}
function contextOf(modelName) {
  if (!modelName) return 0;
  const em = effModel();
  const hit = S.models.find((m) => m.model === modelName);
  return ctxInfoOf(em && em.provider, modelName).tokens || (hit ? hit.contextTokens : 0);
}
function ctxSourceZh(src) {
  if (src === 'override') return '来自你在「模型配置」里填的覆盖值';
  if (src === 'pi') return '来自内置模型表';
  return '未知：模型目录还没读到，或这个模型不在目录里';
}

// null = 不知道（模型目录还没到），true/false = 明确
function visionOf(modelName) {
  if (!modelName || modelName === '—') return null;
  const hit = S.models.find((m) => m.model === modelName);
  return hit ? !!hit.images : null;
}
function activeModelName() {
  const em = effModel();
  return em ? em.model : $('kv-model').textContent;
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

// 没有用量数据时，用量条该显示什么 —— 把"分母是多少、从哪来"摆出来。
// 抽出来是因为现在有三条路会走到这个状态（换模型 / 恢复默认 / 改覆盖值后重算），
// 三处各写一遍迟早会分叉。
function paintCtxIdle() {
  const em = effModel();
  const ci = ctxInfoOf(em && em.provider, em && em.model);
  $('ub-fill').style.width = '0%';
  $('ub-fill').className = '';
  $('ub-text').textContent = '— / ' + ctxLabel(ci);
  $('sb-usage').title = ci.tokens
    ? ('上下文总窗口 ' + ci.tokens + ' 词元\n分母来源：' + ctxSourceZh(ci.source) + '\n（点一下看明细）')
    : ('上下文窗口未知\n分母来源：' + ctxSourceZh(ci.source) + '\n（点一下看明细）');
  paintCache(null);   // 没有用量数据 → 缓存命中回到 —（不编 0%）
}

// 缓存命中（老板 2026-10-13：「加个缓存命中到最下方栏」）。
// pi 的 usage 结构（vendor/pi 的 message-types.md）：
//   {input, output, cacheRead, cacheWrite, totalTokens, cost}
// 提示词总量 = input + cacheRead + cacheWrite（totalTokens 还含 output，不能当分母）；
// 命中率 = cacheRead / 提示词总量。
// 纯函数放这里是为了验收能直接喂各种 usage 形状（模型不支持缓存 → 全 0 → null）。
function cacheStats(usage) {
  if (!usage) return null;
  const read = Number(usage.cacheRead) || 0;
  const write = Number(usage.cacheWrite) || 0;
  const input = Number(usage.input) || 0;
  // 读和写都是 0 = 这一轮**没有任何缓存活动**。两类模型都会长成这样：
  //   ① 不支持 prompt cache 的（永远 0）；
  //   ② 支持但还没开始写的（首轮之前）。
  // 这两种都该显示 —（未知）而不是 0% —— 编一个 0% 会让用户以为"缓存坏了"，
  // 而事实可能只是这个模型压根没有缓存。（一旦出现写入，下一轮就能看到真实命中率。）
  if (read <= 0 && write <= 0) return null;
  const prompt = input + read + write;
  if (prompt <= 0) return null;              // 兜底：除零保护
  return { hit: read / prompt, read, write, input, prompt };
}
function paintCache(st) {
  S.cache = st;
  const b = $('kv-cache');
  const box = $('sb-cache');
  if (!b || !box) return;
  if (!st) {
    b.textContent = '—';
    box.classList.remove('hot');
    box.title = '提示词缓存命中率\n这一轮还没有用量数据，或模型不支持缓存';
    return;
  }
  const pct = Math.round(st.hit * 100);
  b.textContent = pct + '%';
  // 命中过半给个绿色小点亮 —— 缓存是真金白银（更便宜也更快），值得被看见
  box.classList.toggle('hot', pct >= 50);
  box.title =
    '提示词缓存命中率 ' + pct + '%\n' +
    '命中（缓存读）：' + fmtTokens(st.read) + ' 词元\n' +
    '未命中（新输入）：' + fmtTokens(st.input) + ' 词元\n' +
    '缓存写：' + fmtTokens(st.write) + ' 词元\n' +
    '（命中部分按缓存价计费，也更快；模型不支持缓存时这里一直是 —）';
}

// 点用量条 → 把这几个数**分别**说清楚（已用 / 分母 / 占比 / 来源 / 缓存），
// 顺便给一条"哪儿能改"的指路。含糊的总数只会引出下一个问题。
function showUsageDetail() {
  const em = effModel();
  const ci = ctxInfoOf(em && em.provider, em && em.model);
  const used = (S.lastUsage && S.lastUsage.totalTokens) || 0;
  const pct = ci.tokens ? Math.min(100, Math.round((used / ci.tokens) * 100)) : 0;
  const hit = em ? S.models.find((m) => m.model === em.model && (!em.provider || m.provider === em.provider)) : null;
  const lines = [
    '当前模型：' + (em ? ((em.provider ? em.provider + '/' : '') + em.model) : '（还不知道）'),
    '本轮已用：' + fmtTokens(used) + ' 词元' + (S.lastUsage ? ('（输入 ' + fmtTokens(S.lastUsage.input || 0) +
      ' · 输出 ' + fmtTokens(S.lastUsage.output || 0) + ' · 缓存读 ' + fmtTokens(S.lastUsage.cacheRead || 0) +
      ' · 缓存写 ' + fmtTokens(S.lastUsage.cacheWrite || 0) + '）') : ''),
    '上下文窗口：' + (ci.tokens ? (ctxLabel(ci) + '（' + ci.tokens + ' 词元）') : '未知'),
    '占用比例：' + (ci.tokens ? pct + '%' : '—'),
    '缓存命中：' + (S.cache ? (Math.round(S.cache.hit * 100) + '%（读 ' + fmtTokens(S.cache.read) +
      ' / 写 ' + fmtTokens(S.cache.write) + ' / 新输入 ' + fmtTokens(S.cache.input) + '）') : '—'),
    '',
    '分母来源：' + ctxSourceZh(ci.source),
    hit ? ('模型表里写的是 ' + hit.context + '，最大输出 ' + hit.maxOut) : '模型表里没有这个模型',
    '',
    '要改这个分母：打开模型选择器 → 找到这一行 → 「配置」→ 填「上下文窗口」。',
    '（只是让百分比算得对，不改变 AI 实际能收多少上下文。）'
  ];
  return confirmBox('上下文用量', lines.join('\n'));
}

function setUsage(usage, modelName) {
  if (!usage) return;
  S.lastUsage = usage;            // 存下来：模型目录晚到时好补算分母
  S.lastUsageModel = modelName;
  paintCache(cacheStats(usage));
  const used = usage.totalTokens || 0;
  const em = effModel();
  const ci = ctxInfoOf(em && em.provider, em && em.model);
  const ctx = ci.tokens;
  $('ub-text').textContent = fmtTokens(used) + ' / ' + ctxLabel(ci);
  const pct = ctx ? Math.min(100, Math.round((used / ctx) * 100)) : 0;
  const fill = $('ub-fill');
  fill.style.width = (ctx ? Math.max(2, pct) : 0) + '%';
  fill.className = pct >= 85 ? 'hot' : (pct >= 60 ? 'warn' : '');
  $('sb-usage').title = ctx
    ? ('上下文占用 ' + pct + '%（' + used + ' / ' + ctx + ' 词元）\n分母来源：' + ctxSourceZh(ci.source) + '\n（点一下看明细）')
    : ('已用 ' + used + ' 词元（上下文窗口未知：' + ctxSourceZh(ci.source) + '）\n（点一下看明细）');
}

/* ============================================================
   图片附件
   ------------------------------------------------------------
   为什么要有预览条：图一旦发出去就落盘成路径了，用户得在发之前
   确认「我到底要发哪几张」。而且默认模型很可能看不懂图，
   这里要提前用当前模型的 images 能力给出警告，别让用户以为 AI 眼瞎。
   ============================================================ */
const MAX_ATT_BYTES = 16 * 1024 * 1024;
// 非图片附件上限放得更宽。**两种通路**：
//   · 有磁盘路径的（资源管理器拖/点选）→ 路径直传，不经 base64，多大都不额外开销；
//   · 虚拟文件（微信/QQ/网页里的，没路径）→ 只能读内容经 IPC 落盘，这时 50MB 是真在拷字节。
// 真正的约束其实是模型上下文 —— 附件超大时 pi 会把内容内联进 prompt，
// 模型读不读得下是它的事；这里只挡"明显不该塞进来的巨型文件"。
// ★ 这个数必须和 attach.js 的 MAX_FILE_BYTES 一致（那边是最后一道防线），
//   attach.test.js 里有一条断言直接解析这行源码比对，防止两处漂开。
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// 附件 id：原来三处各写一遍同样的拼法（图片 / 路径直传 / 虚拟文件落盘），
// 抽出来免得加一条新通路就漏一次（id 撞了会让「✕ 移除」误删同名的另一条）
function attId() {
  return 'a' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// 附件徽章文字：取扩展名大写（note.pdf → PDF、main.js → JS），没扩展名叫「文件」
function extBadge(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toUpperCase() : '文件';
}

function addAttachment(file) {
  if (!file) return;
  // 张数上限走设置（默认 4）。超了要**说清楚**而不是静默丢掉。
  const cap = (CFG && CFG.maxImages) ? CFG.maxImages : 4;
  const pending = S.attachments.length + S.attLoading;
  if (pending >= cap) {
    addMsg('err', 'ERR', '一次最多带 ' + cap + ' 个附件（现在已有 ' + pending + ' 个，可在「设置」里调）');
    return;
  }

  // ★ 进来的东西有**两种形状**，必须分开对待（这是 2026-10-12 深夜差点漏掉的坑）：
  //   ① 真 File/Blob（拖拽 / 粘贴 / 点选）：有 size/type 和 arrayBuffer/slice，磁盘路径要靠 pathForFile 问；
  //   ② 「调用方已经解析好路径的普通对象」{name,size,type,path}：
  //      **HTML 拖拽**（Chromium 只给 text/uri-list，不给 File 对象）走的就是这种，
  //      由 addAttachmentFromPath 用 statFile 补齐后交过来。
  //   ⚠ 我第一版重写这里时只想着第①种：于是第②种的 `file.path` 被无视、
  //     还去调 `file.arrayBuffer()`（普通对象没有这个方法）⇒ **拖 .html 进来直接报"读不出来"**。
  //     而测试当时全绿 —— 因为 uri-list 这条路**一条断言都没有**（零覆盖 = 静默坏掉）。
  const isBlob = typeof file.arrayBuffer === 'function';
  const givenPath = (typeof file.path === 'string' && file.path) ? file.path : '';

  // ── 图片：走 dataURL（要出缩略图 + 发前体检，防 pi 静默丢图） ──
  // 只有真 Blob 才能 readAsDataURL —— 普通对象（HTML 拖拽过来的那些）走下面按路径走，
  // 否则 `new FileReader().readAsDataURL(plainObj)` 会**抛异常**到事件监听器外面去。
  if (/^image\//.test(file.type || '') && isBlob) {
    if (file.size > MAX_ATT_BYTES) {
      addMsg('err', 'ERR', '图片太大（' + fmtBytes(file.size) + '，上限 16M）');
      return;
    }
    S.attLoading += 1;
    const r = new FileReader();
    r.onerror = () => { S.attLoading = Math.max(0, S.attLoading - 1); addMsg('err', 'ERR', '这张图读不出来（' + esc(file.name || '未命名') + '）'); };
    r.onload = () => {
      S.attLoading = Math.max(0, S.attLoading - 1);
      S.attachments.push({
        id: attId(),
        name: file.name || ('pasted-' + Date.now() + '.png'),
        size: file.size,
        mime: file.type || 'image/png',
        dataUrl: r.result
      });
      renderAtt();
    };
    r.readAsDataURL(file);
    return;
  }

  // ── 非图片（PDF/文本/代码/Office…）：优先按路径直传 ──
  // ★ 老板 2026-10-12 23:5x「为什么不能直接把文件拖进去」——根因不是"这种文件不支持"，
  //   是 Electron 32+ **删掉了非标准属性 File.path**（探针实测 44.7.0：'path' in f === false，
  //   f.path === undefined）。老代码 `if (!file.path) 报错` 于是**恒成立** ——
  //   从资源管理器拖 PDF 进来、用「+ 附件」选、复制粘贴的文件，一条都进不来；
  //   那句"存到磁盘再拖进来"更是驴唇不对马嘴，用户本来就是从磁盘拖的。
  //   官方替代是 webUtils.getPathForFile（preload 暴露成 api.pathForFile；
  //   探针实测：真实落盘文件经 contextBridge 传进去仍能拿回真路径，虚拟文件返回 ''）。
  if (!file.size) {
    addMsg('err', 'ERR', '这份文件是空的（' + esc(file.name || '未知') + '）');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    addMsg('err', 'ERR', '文件太大（' + fmtBytes(file.size) + '，上限 ' + fmtBytes(MAX_FILE_BYTES) + '）');
    return;
  }

  // 路径从哪来，按形状分两支：
  //   · 普通对象（HTML 拖拽）→ 调用方（statFile）已经给了解析好的真路径，直接用，别再问；
  //   · 真 File → 问 webUtils.getPathForFile（见上面的长注释：Electron 32+ 删了 File.path）
  const diskPath = givenPath || ((api && api.pathForFile) ? (api.pathForFile(file) || '') : '');
  if (diskPath) {
    S.attachments.push({
      id: attId(),
      name: file.name || diskPath.split(/[\\/]/).pop() || 'file',
      size: file.size,
      mime: file.type || '',
      path: diskPath
    });
    renderAtt();
    return;
  }

  // 真拿不到路径：微信/QQ/Outlook/浏览器里拖出来的是**虚拟文件** —— 有内容、没有后端路径。
  // 退路是把内容读出来交给主进程落进附件目录，回来就是一个普通路径附件。
  // 关键认知：拿不到**路径**不等于拿不到**文件**，所以别再让用户"存到磁盘再拖一次"。
  // 但这条退路**必须先有内容可读**（isBlob）—— 普通对象既没路径又没 Blob，就是真没法附，
  // 老老实实说一句，而不是让 `file.arrayBuffer()` 抛出去（那会变成谁也看不懂的报错）。
  if (!isBlob) {
    addMsg('err', 'ERR', '这份东西既没有磁盘路径也没有内容，附不上去（' + esc(file.name || '未知') + '）');
    return;
  }
  if (!api || !api.saveFile) {
    addMsg('err', 'ERR', '这个版本附不了这种文件（' + esc(file.name || '未知') + '），用「+ 附件」按钮选它');
    return;
  }
  const vName = file.name || 'file';
  S.attLoading += 1;
  file.arrayBuffer()
    .then((buf) => api.saveFile({ name: vName, mime: file.type || '', bytes: new Uint8Array(buf) }))
    .then((r) => {
      S.attLoading = Math.max(0, S.attLoading - 1);
      if (!r || r.ok === false) {
        addMsg('err', 'ERR', '这份文件存不下来（' + esc(vName) + '）：' + esc((r && r.reason) || '未知原因'));
        return;
      }
      S.attachments.push({
        id: attId(),
        name: r.name || vName,
        size: r.size,
        mime: r.mime || file.type || '',
        path: r.path
      });
      renderAtt();
    })
    .catch((e) => {
      S.attLoading = Math.max(0, S.attLoading - 1);
      addMsg('err', 'ERR', '这份文件读不出来（' + esc(vName) + '）：' + esc(String((e && e.message) || e)));
    });
}

function renderAtt() {
  const bar = $('attbar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!S.attachments.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  // 模型看不懂图就先说清楚，不然后面会怀疑「AI 怎么在瞎猜」。
  // 只在真带了图片时才提示 —— 纯文件附件跟看图能力无关，别吓人。
  const hasImg = S.attachments.some((a) => a.dataUrl);
  const vis = hasImg ? visionOf(activeModelName()) : true;
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
    if (a.dataUrl) {
      const img = el('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      d.appendChild(img);
    } else {
      // 非图片附件：扩展名徽章块，跟缩略图同尺寸占位
      d.appendChild(el('span', 'att-doc', esc(extBadge(a.name))));
    }
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

/* ---------- 粘贴附件（图片 + 资源管理器里复制的文件） ---------- */
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  let got = 0;
  const items = cd.items || [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile && it.getAsFile();
    if (!f) continue;
    // 原来这里还有 `&& !f.path` 一道闸：非图片、又没磁盘路径的直接 continue。
    // 两个问题：① File.path 在 Electron 44 恒为 undefined ⇒ **所有**粘贴进来的非图片
    // 文件都被静默丢掉（连句提示都没有，最难查的那种"没反应"）；
    // ② 现在没路径也能走"读内容落盘"那条退路，没必要再拦。addAttachment 自己会说清楚。
    addAttachment(f); got++;
  }
  // 只在真的吃到了附件时才阻止默认行为，
  // 否则会把「往输入框里粘贴文字」也一起吞掉
  if (got) { e.preventDefault(); addMsg('step', 'SYS', '&gt; 已加入 ' + got + ' 个附件'); }
});

/* ---------- 拖拽附件 ---------- */
// 判定"这次拖拽算不算带文件"。
// ★ 不能只看 'Files'：拖 .html/.htm 时 Chromium 把文档类文件只放进
//   text/uri-list（file:///…）和 DownloadURL，dt.files 是空的 ——
//   只认 Files 的话 dragover 就不会 preventDefault，Chromium 直接导航打开那个
//   html（页面像刷新了一样），drop 事件压根不触发。这就是"HTML 拉不进去"的根因。
function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) return true;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'text/uri-list') >= 0) return true;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'DownloadURL') >= 0) return true;
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
  const dt = e.dataTransfer;
  const files = Array.prototype.slice.call(dt.files || []);
  if (files.length) {
    files.forEach(addAttachment);
    return;
  }
  // 老板 2026-10-12：「有一些文件它还是没办法拉进去，比如 Html 的」。
  // 根因（Chromium 已知行为）：从资源管理器拖 **.html/.htm** 进窗口时，
  // Chromium 把它当成"一个网页文档"而不是"一个文件" —— dt.files 是空的，
  // 只在 text/uri-list（file:///E:/xxx.html）或 DownloadURL 里留下地址。
  // 老代码 files.forEach 一个都不跑 → 看着就是"拉不进去"。
  // 修法：从 uri-list / DownloadURL 里把本地路径抠出来，走 addAttachmentFromPath。
  const uris = [];
  try {
    const ul = dt.getData('text/uri-list') || '';
    ul.split(/[\r\n]+/).forEach((s) => { if (s.trim()) uris.push(s.trim()); });
  } catch (e1) { /* 某些类型取不到会抛，忽略 */ }
  try {
    const dl = dt.getData('DownloadURL') || '';   // 形如 mime:name:url
    if (dl) {
      const parts = dl.split(':');
      if (parts.length >= 3) {
        const url = parts.slice(2).join(':');
        if (/^file:\/\//i.test(url)) uris.push(url);
      }
    }
  } catch (e2) { /* ignore */ }
  const localPaths = uris
    .map((u) => uriToLocalPath(u))
    .filter((p) => p);
  if (!localPaths.length) {
    addMsg('err', 'ERR', '这份东西拿不到文件（拖进来的可能是个链接或网页内容，不是磁盘文件）');
    return;
  }
  localPaths.forEach(addAttachmentFromPath);
});

// file:///E:/a/b.html → E:\a\b.html（含中文要先 decodeURIComponent，空格是 %20）
function uriToLocalPath(uri) {
  let s = String(uri || '').trim();
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/\//i, '');
    // file://server/share 形态（UNC）在这里用不到，直接放弃而不是拼出个错路径
    if (/^[a-z]:/i.test(s) === false && s.indexOf('/') >= 0 && !s.startsWith('/')) return '';
  } else if (/^[a-z]:[\\/]/i.test(s)) {
    // 资源管理器偶尔直接给裸路径
  } else {
    return '';
  }
  try { s = decodeURIComponent(s); } catch (e) { /* 含 % 但非编码，原样用 */ }
  return s.replace(/\//g, '\\');
}

// 只有路径、没有 File 对象时（HTML 拖拽就是这种）：先问主进程要 name/size 再走同一套把关
function addAttachmentFromPath(p) {
  if (!api || !api.statFile) {
    addMsg('err', 'ERR', '这个版本拖不了这种文件（' + esc(p) + '），用「+ 附件」按钮选它');
    return;
  }
  api.statFile(p).then((st) => {
    if (!st || st.ok === false) {
      addMsg('err', 'ERR', '读不到这个文件（' + esc(p) + '）：' + esc((st && st.error) || '不存在或被占用'));
      return;
    }
    addAttachment({
      name: st.name,
      size: st.size,
      type: st.mime || '',
      path: p
    });
  }).catch((e) => {
    addMsg('err', 'ERR', '读不到这个文件（' + esc(p) + '）：' + esc(String((e && e.message) || e)));
  });
}

/* ---------- 点选附件（不限制类型，任何文件都能选） ---------- */
const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.accept = '';   // 不限类型：PDF/文本/代码/Office 都行，addAttachment 里分类把关
filePicker.multiple = true;
filePicker.style.display = 'none';
// 给个 id：验收要能把**真实落盘文件**塞进来（CDP 的 DOM.setFileInputFiles 按选择器找节点），
// 页面里 input[type=file] 不止一个，靠 querySelectorAll 顺序猜迟早会指错元素。
filePicker.id = 'file-picker';
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

  // 老板 2026-10-11 17:44：`/` 命令不再弹候选菜单（都鼠标可点，冗余），
  // 但保留"能直接敲 /new /rename foo"的能力 —— 输入完整命令 + Enter 直接执行。
  // 未知命令给一条 err 提示，别静默把它当聊天发出去。
  if (text.startsWith('/') && !nAtt) {
    const sp = text.indexOf(' ');
    const k = sp === -1 ? text : text.slice(0, sp);
    const arg = sp === -1 ? '' : text.slice(sp + 1).trim();
    const c = COMMANDS.find((x) => x.k === k);
    if (!c) {
      input.value = '';
      syncCursor();
      closePalette();
      addMsg('err', 'ERR', '没有这个命令：' + esc(text) + '。可用的命令：' + COMMANDS.map((x) => x.k).join('、'));
      return;
    }
    input.value = '';
    syncCursor();
    closePalette();
    addMsg('user', 'YOU', esc(text));
    pushRecent(c.k);
    try {
      const r = arg ? c.run(arg) : c.run();
      if (r && typeof r.then === 'function') {
        r.catch((e) => addMsg('err', 'ERR', (e && e.message) || String(e)));
      }
    } catch (e) {
      addMsg('err', 'ERR', (e && e.message) || String(e));
    }
    return;
  }

  if (!text && !nAtt) return;
  if (S.busy) { addMsg('err', 'ERR', '上一轮还没结束，先按 ESC 停掉它。'); return; }

  // 附件分两路：图片走 dataURL（落盘+体检），文件走磁盘路径直传
  const images = S.attachments.filter((a) => a.dataUrl).map((a) => ({ name: a.name, dataUrl: a.dataUrl }));
  const docFiles = S.attachments.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name }));
  const nImg = images.length, nDoc = docFiles.length;

  input.value = '';
  syncCursor();
  S.lastUser = text;
  S.round += 1;
  S.attSent = nImg;      // 记账：这一轮发了几张图，等 pi 回显时对账（文件不算，pi 不回显文件）
  S.imgIn = 0;
  S.imgWarned = false;
  $('kv-round').textContent = String(S.round);
  S.busy = true;
  btnStop.classList.remove('hidden');
  setState('THINKING');
  startTimer();
  const attTag = nImg && nDoc ? ('附件×' + (nImg + nDoc)) : nImg ? ('图×' + nImg) : ('文件×' + nDoc);
  addMsg('user', 'YOU', esc(text || (nImg ? '(只看图)' : '(只发附件)')), nAtt ? attTag : null);
  clearAtt();

  if (!api) { demoReply(text); return; }

  api.ask({ text, images, files: docFiles }).then((r) => {
    if (r && r.ok === false) {
      if (r.reason === 'IMAGE_REJECTED') {
        addMsg('err', 'IMG', '这些附件没收下，所以没发出去：' + esc(rejText(r.rejected)));
      } else {
        addMsg('err', 'ERR', '主进程拒绝了这次请求：' + esc(reasonZh(r.reason)));
      }
      endTurn(-1);
      return;
    }
    // 部分被拒：好的照发，坏的要说清楚为什么（不能让用户以为全都发出去了）
    if (r && Array.isArray(r.rejected) && r.rejected.length) {
      addMsg('err', 'IMG', '有 ' + r.rejected.length + ' 个附件没能发送：' + esc(rejText(r.rejected)));
    }
  }).catch((e) => {
    addMsg('err', 'ERR', '发送失败：' + (e && e.message ? e.message : e));
    endTurn(-1);
  });
}

// 把附件被拒的原因拼成一行给人看的话
function rejText(rejected) {
  if (!Array.isArray(rejected) || !rejected.length) return '';
  return rejected.map((x) => (x && x.name ? x.name : '一个附件') + '（' + ((x && x.reason) || '未知原因') + '）').join('；');
}

function endTurn(code) {
  S.busy = false;
  stopTimer();
  btnStop.classList.add('hidden');
  removeCaret();
  setState('DONE');
  if (code !== 0 && code != null) {
    addMsg('err', 'ERR', '进程退出码 ' + code + '（看看是不是没认证 / 没 key）');
  } else if (code === 0) {
    // 老板 2026-10-13：「还要有桌面提醒功能」—— 一轮干完、用户已经切去看别的窗口时，
    // 系统通知报一声。失败的一轮不走这里（界面里已经红着说了，不再补刀）。
    const secs = S.startedAt ? ((Date.now() - S.startedAt) / 1000).toFixed(1) : '?';
    desktopNotify('这一轮忙完了', '用了 ' + secs + ' 秒，点开看看结果');
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
  resize: '没能把这张图处理进请求（图本身解不开 / 尺寸或体积超过内联上限）。换一张能正常打开的图再试。',
  // 指路要指到**真的存在**的入口上：/model 这条命令已经删了，
  // 模型入口只剩状态栏那个「模型」按钮（老板原话："UI 界面上已经有了"）。
  nomodel: '当前模型不看图，图被丢掉了。点状态栏的「模型」按钮，换一个列表里带「看图」标记的模型。'
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

  // 后台任务登记表整表推送（主进程起落点调用 bgBegin/bgEnd 时发）。
  // 整表覆盖而不是增量 —— 表极小（同时最多几条），覆盖最简单也不会乱序。
  if (msg.kind === 'bg') {
    S.bg = Array.isArray(msg.tasks) ? msg.tasks : [];
    renderBg();
    return;
  }

  // `!` shell 的流式输出
  if (msg.kind === 'shell') {
    const t = S.shellEls[msg.id];
    if (msg.done) {
      // 老板 2026-10-13：桌面提醒 —— `!` 命令也在后台跑，跑完（尤其跑砸了）
      // 而用户已经切走时，系统通知报一声。
      if (t) {
        t.code.textContent = '退出码 ' + msg.code;
        if (msg.code !== 0) t.code.classList.add('bad');
        delete S.shellEls[msg.id];
      }
      desktopNotify(
        msg.code === 0 ? '命令跑完了' : ('命令跑砸了（退出码 ' + msg.code + '）'),
        msg.code === 0 ? '点开看输出' : '点开看看哪儿错了');
      scrollEnd();
      return;
    }
    if (!t) return;
    if (msg.data) {
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
          '&gt; 本轮正常结束（退出码 0），但 stderr 有 ' +
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
          esc(IMG_OMIT_WHY[info.omit.key] || '这张图片被丢掉了') +
          (S.attSent ? '（本轮带了 ' + S.attSent + ' 张图）' : '') +
          (info.omit.text ? ' ｜ 原因：' + esc(info.omit.text) : ''));
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
        // 老板 2026-10-11：AI 开始输出正文 → 吉祥物敲键盘（TOOL 态），
        // 思考阶段（thinking_*）仍是 THINKING 抬头想。文本流结束后状态
        // 由后续事件接管（toolcall_start→TOOL / 轮次结束→IDLE）。
        setState('TOOL');
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
      // 没手动切过时，把"真跑出来的模型"记下来 —— 状态条要显示它而不是干巴巴的"默认"
      if (!S.curModel) { S.observedModel = ev.message.model; S.observedProvider = ev.message.provider || null; }
      $('set-curmodel').textContent = (ev.message.provider || '') + '/' + ev.message.model;
      paintModelBar();     // 里面会 updateVision()，别在外面再调一遍
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
// 验收入口（2026-10-13 桌面提醒）：直接调 desktopNotify 看"设置关没关 / 焦点在不在"
// 这两条守卫生不生效 —— 不暴露的话这条决策表只能靠真弹系统通知来验，没法自动化。
window.__pixelNotify = desktopNotify;
// 验收入口：导出 / 删除结果处理都要能**绕过需要人工点的对话框**单独调用。
// 它们各自绑着 system 保存框 / confirmBox，不抽出来就永远只能靠肉眼验。
window.__pixelExport = (seq, outPath, fmt) => exportSession({ seq: seq, title: '' }, outPath, fmt);
window.__pixelCfg = () => CFG;                                   // 验收脚本读当前生效的设置
window.__pixelApplyCfg = (c) => applyCfg(c);                     // 验收脚本直接灌一份设置看效果
// 按 seq 打开会话：走渲染层这条**真实**路径（不是裸调 IPC），
// 否则 S.seq 不会跟着变，后面 `/rename` 之类依赖"当前会话"的功能就测歪了。
window.__pixelOpenSession = (seq) => openSession(seq);
window.__pixelApplyDelete = (seq, res) => applyDeleteResult(seq, res);
// 反向验证用：把「往时间线塞一条消息」这条**老路**暴露出来，
// 好让验收能证明"它确实会把主页藏掉" —— 不然 toast 方案只是碰巧通过。
window.__pixelAddMsg = (k, t, h) => addMsg(k, t, h);
// 模型配置框的内部状态。为什么要暴露：验收时"点保存没生效"有两种完全不同的原因 ——
// ① 值没进输入框；② 值进了但 MCFG.sel 已经被清掉（对话框被谁关了）。只看配置文件
// 是分不出这两种的，而它们的修法完全相反。
window.__pixelMcfg = () => ({ sel: MCFG.sel, testing: MCFG.testing, hasInfo: !!MCFG.info });
// 老板 2026-10-11 17:44：/ 命令面板不弹了，验收要能直接读命令表；
// 不然"是否真的没有 /model"只能靠 UI 弹面板去看 —— 而面板现在根本不弹。
// 注意：COMMANDS 在文件后面才声明（`const COMMANDS = [...]`），
// 这里不能访问 —— 暴露点被挪到 COMMANDS 定义之后。
// 「中断了几次」—— 只有可观测才验得动。
// 起因：设置面板开着时按 Esc，原来会掉进 doAbort() 把正在跑的这轮**中断掉**，
// 而面板还不关。doAbort 里有 `if (!S.busy) return`，测试时没在跑就什么都看不出来，
// 所以计数器必须放在 busy 判断**之前**，否则这条 bug 永远测不到。
window.__pixelAborts = 0;
// 更新提醒三件套 + 周期值。为什么要暴露：
//   "没更新时会时不时再提醒"是**时间行为**，只能靠验收把 10 分钟压成几百毫秒来验；
//   再把 show/stop 单独拿出来，就能脱离"启动时恰好查到什么"验边界。
//   （girlSay 的粘性是首屏时序 bug 的根因，所以粘性也必须在验收里能被反向验证。）
window.__pixelUpdate = {
  show: (r, fakeApi) => showUpdateReminder(r, fakeApi),
  start: (fakeApi, everyMs) => startUpdateReminderLoop(fakeApi, everyMs),
  stop: () => stopUpdateReminder(),
  bootstrap: (fakeApi) => bootstrapUpdateCheck(fakeApi),
  every: UPDATE_REMIND_EVERY_MS,
  bubbleMs: UPDATE_BUBBLE_MS,
  running: () => !!updateLoop
};

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
  // 换会话了，上一个会话"实际跑出来的模型"不能留着 —— 不然后面 openSession 到
  // 一个没有 model 记录的会话时，状态条会继续显示上一个会话的模型（串味）。
  S.observedModel = null;
  S.observedProvider = null;
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
      if (!S.curModel) { S.observedModel = h.model; S.observedProvider = h.provider || null; }
      paintModelBar();     // 里面会 updateVision()
    } else if (!S.curModel) {
      paintModelBar();     // 这个会话没有模型记录 → 回落到 pi 默认，别留着上一个的
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
  S.lastUsage = null;          // 新会话：上一轮的用量不能跟着过来
  S.lastUsageModel = null;
  S.observedModel = null;      // 同理，模型也重新观察
  S.observedProvider = null;
  $('kv-round').textContent = '0';
  $('kv-model').textContent = '—';
  // 走统一入口：没手动切过模型时这里要显示 pi 的真实默认模型名，
  // 分母也要跟着摆出来。直写"默认"和"— / —"会跟 piDefault 逻辑打架。
  paintModelBar();
  paintCtxIdle();
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
  await applyDeleteResult(r.seq, await api.deleteSession(r.seq));
}

// 把「删除结果」翻译成界面动作。
// 单独抽出来是为了可测：deleteSession 里那一步会先弹确认框，
// 自动化验收点不了它 —— 逻辑留在一个点不动的地方，就只能靠肉眼看了。
//
// ★ 两个坑都在这一个函数里：
//   ① 回主页不能靠 `welcome.classList.remove('hidden')` 然后**继续 addMsg** ——
//      addMsg 走的是 showTimeline()，会把刚显示出来的主页**又藏回去**。
//      现象就是老板说的"删完所有会话没有返回主页"，只能看到一条「已移入回收站」。
//      ⇒ 真话得挂在时间线之外的 **toast** 上。
//   ② 删掉当前会话但还剩别的会话时，只把 S.seq 改成新序号是**假的切换**：
//      时间线还是空的，用户对着一个"有内容的会话"发呆。
//      ⇒ 真去 openSession(res.current) 把历史读出来。
//   ★ 所以这个函数是 async 的：openSession 里第一件事就是 `log.innerHTML = ''`，
//     要是在它 resolve 之前就往时间线里 addMsg，那条消息会被**清掉**（白说一句）。
//     验收脚本 `await window.__pixelApplyDelete(...)` 也靠这个 promise 等历史加载完。
async function applyDeleteResult(seq, res) {
  if (!res || res.ok === false) {
    addMsg('err', 'ERR', '删除失败：' + reasonZh(res && res.reason));
    return false;
  }
  if (res.sessions) renderSessions(res.sessions);
  const left = (res.sessions || []).length;
  // 回收站那一步报了异常、但文件确实已移出：说实话，别假装一切正常，
  // 也别谎报失败 —— 用户需要知道的是"可恢复性没确认"。
  const note = res.trashNote
    ? '会话 #' + seq + ' 已从列表移除，但回收站操作报了异常（' + res.trashNote + '）—— 可恢复性未能确认。'
    : '会话 #' + seq + ' 已移入回收站（可恢复）';

  if (res.removedCurrent) {
    S.tools = []; S.todos = []; S.subs = [];
    renderTools(); renderTodos(); renderSubs();
    S.seq = res.current;
    updateCur(S.seq);
    // 删的是当前会话：时间线马上要被清空／重填，所以这句提示一律走 toast（时间线之外）
    toast(note, res.trashNote ? 'warn' : 'ok');
    if (!left) {
      // 一条都不剩 → 真正回主页（清时间线 + 显示欢迎区）
      doNewSessionLocal();
      return true;
    }
    // 还有别的会话：把它的历史真的加载出来（等它加载完再返回）
    await openSession(res.current);
    return true;
  }
  // 删的不是当前会话：时间线保持原样，说一句没问题
  addMsg('step', 'SYS', '&gt; ' + esc(note));
  return true;
}

// outPath 可选：给了就跳过系统保存框直接写过去（自动化验收 / 脚本用）。
// 不给则弹框问用户 —— 界面按钮走的是这条路。
// fmt 可选：不传就用设置里的「导出格式」（html / md / json，三种都是真格式）
async function exportSession(r, outPath, fmt) {
  if (!api) return null;
  // 老板 2026-10-12：默认 MD（老配置里选过 html 的仍然尊重，见 main.js loadCfg）
  const format = fmt || (CFG && CFG.exportFormat) || 'md';
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
  const cnt = $('sub-count');
  // 老板 2026-10-13：「子代理也是」—— 标题带数量：运行中 x / 共 y。
  // 运行中数单独数出来：忙碌时最想先看见的就是"还有几个在跑"。
  if (cnt) {
    const running = (S.subs || []).filter((s) => s.state === 'running').length;
    cnt.textContent = S.subs.length ? ('（' + running + ' 运行中 / 共 ' + S.subs.length + '）') : '';
  }
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

/* ---------- 后台任务（老板 2026-10-13：「后台有任务的话我希望可以显示在
   右上角智能体栏目里面并显示数量」） ----------
   数据来自主进程的登记表（pi 对话轮次 + `!` shell 命令），整表推送。
   只画"现在还在跑的"吗？不 —— 刚干完的那条也有价值（看得见刚才干了什么），
   所以画全表；表里只留运行中的（主进程 bgEnd 就删），干完即消失。
   计数 = 当前还在跑的数量。 */
function renderBg() {
  const box = $('bg-list');
  const empty = $('bg-empty');
  const cnt = $('bg-count');
  const list = S.bg || [];
  const running = list.filter((x) => x.state === 'running').length;
  if (cnt) cnt.textContent = list.length ? ('（' + running + ' 个在跑）') : '';
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) {
    if (empty) { empty.classList.remove('hidden'); empty.textContent = '现在没有后台任务'; }
    bgTickSync();
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.forEach((x) => {
    const d = el('div', 'agent-item live');
    const secs = ((Date.now() - (x.at || Date.now())) / 1000).toFixed(0);
    d.innerHTML =
      '<span class="ag-n">' + esc(bgKindZh(x.kind)) + '</span>' +
      (x.label ? '<span class="ag-p">' + esc(x.label) + '</span>' : '') +
      '<span class="ag-tag">' + (x.state === 'running' ? ('跑着 · ' + secs + 's') : esc(x.state)) + '</span>';
    box.appendChild(d);
  });
  bgTickSync();
}
function bgKindZh(k) {
  return k === 'turn' ? '对话轮次' : k === 'shell' ? '终端命令' : (k || '任务');
}
// 「跑着 · Ns」里的 N 要真的在走：有运行中的任务就挂一个 1 秒的轻量重绘，
// 没有就收摊（别让一个空转的 interval 常驻）。重绘只碰右栏那一小块。
let bgTick = null;
function bgTickSync() {
  const running = (S.bg || []).some((x) => x.state === 'running');
  if (running && !bgTick) bgTick = setInterval(() => renderBg(), 1000);
  else if (!running && bgTick) { clearInterval(bgTick); bgTick = null; }
}

function renderExts() {
  const box = $('ext-list');
  const empty = $('ext-empty');
  if (!box) return;
  box.innerHTML = '';
  // 标题数量：老板 2026-10-12「不用自己数」。读取中（null）时不显示数字。
  const cnt = $('ext-count');
  if (cnt) cnt.textContent = S.exts ? ('（' + S.exts.length + '）') : '';
  const list = S.exts;
  if (!list) { empty.classList.remove('hidden', 'bad'); empty.textContent = '读取中…'; return; }
  if (!list.length) {
    empty.classList.remove('hidden', 'bad');
    empty.textContent = '还没装扩展（点上面 ↻ 重新读）';
    return;
  }
  empty.classList.add('hidden');
  list.forEach((x) => {
    const d = el('div', 'agent-item');
    d.innerHTML =
      '<span class="ag-n">' + esc(x.name) + '</span>' +
      (x.path ? '<span class="ag-p">' + esc(x.path) + '</span>' : '') +
      '<span class="ag-tag">' + esc(extSrcZh(x.source)) + '</span>';
    // 更新按钮只在**自动检查发现有新版**时才挂（老板 2026-10-11 23:20：
    // 「每次打开 PixelAgent 自动检查更新，然后才显示全部更新，没有就不用显示」）。
    // 三态：本会话更过 → 绿标；有新版 → 更新按钮；检查完已最新 → 淡标；还没查完 → 什么都不挂。
    if (x.source !== 'local') {
      const pid = pkgIdOf(x);
      if (S.extUpd[pid]) {
        const ok = el('span', 'ext-ok');
        ok.textContent = '最新 ✓';
        d.appendChild(ok);
      } else if (S.extOutdated && S.extOutdated.has(x.name)) {
        const b = el('button', 'ext-upd');
        b.textContent = '更新';
        b.title = '发现新版本，点这里更新';
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          updateOneExt(x, b);
        });
        d.appendChild(b);
      } else if (S.extOutdated) {
        const ok2 = el('span', 'ext-ok dim');
        ok2.textContent = '最新';
        d.appendChild(ok2);
      }
    }
    box.appendChild(d);
  });
  syncUpdateAllBtn();
}

function pkgIdOf(x) { return x.source + ':' + x.name; }

/* 更新扩展 / pi 本体（老板 2026-10-11：PI 有什么更新，直接在 PixelAgent 更新）
   跑的是主进程里的 pi update（最多等 5 分钟），完事刷新列表 + 把输出尾部塞给提示条 */
let updBusy = false;
async function updateOneExt(x, btn) {
  if (updBusy) return;
  updBusy = true;
  const old = btn.textContent;
  btn.textContent = '更新中…';
  btn.disabled = true;
  try {
    const r = await api.updatePi({ ext: pkgIdOf(x) });
    if (r.ok) {
      S.extUpd[pkgIdOf(x)] = Date.now();
      if (S.extOutdated) S.extOutdated.delete(x.name);
    }
    await renderExts();
    toast(r.ok ? ('「' + x.name + '」更新完成：' + tailLine(r.out)) : ('更新失败：' + (r.error || tailLine(r.out))));
  } finally {
    updBusy = false;
  }
}
async function updateAllPi(btn) {
  if (updBusy) return;
  updBusy = true;
  const old = btn.textContent;
  btn.textContent = '更新中…（可能要几分钟）';
  btn.disabled = true;
  try {
    const r = await api.updatePi({});
    if (r.ok) {
      // 本轮全部标成最新 + 待更新清单清空（「全部更新」按钮随之藏起来）
      (S.exts || []).forEach((x) => { if (x.source !== 'local') S.extUpd[pkgIdOf(x)] = Date.now(); });
      S.extOutdated = new Set();
    }
    await renderExts();
    toast(r.ok ? ('已全部更新到最新：' + tailLine(r.out)) : ('更新失败：' + (r.error || tailLine(r.out))));
  } finally {
    updBusy = false;
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}
function tailLine(t) {
  const lines = String(t || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

let agentsLoading = false;
async function loadAgents(force, isAutoRetry) {
  if (!api || agentsLoading) return;
  agentsLoading = true;
  const r = await api.agents();
  agentsLoading = false;
  if (!r) return;
  S.exts = (r.extensions || []).concat(r.local || []);
  renderExts();
  if (r.ok === false) {
    // 老板 2026-10-12 踩坑：刚装完插件时 pi 可能还占着配置锁，list 拉取失败，
    // 旧代码因为列表里还有「自带 todo」一条，把错误整个吞掉 → 看着像「插件全没了」。
    // 现在：① 明确显示失败和重试入口；② 3 秒后自动悄悄再拉一次（锁一般很快释放）。
    const empty = $('ext-empty');
    if (empty) {
      empty.classList.remove('hidden');
      empty.classList.add('bad');
      empty.textContent = '读取失败：' + (r.error || '未知') + '（3 秒后自动重试，或点这里立即重试）';
      empty.style.cursor = 'pointer';
      empty.onclick = () => { S.exts = null; renderExts(); loadAgents(true); };
    }
    if (!isAutoRetry) setTimeout(() => loadAgents(false, true), 3000);
  } else {
    const empty = $('ext-empty');
    if (empty) { empty.classList.remove('bad'); empty.style.cursor = ''; empty.onclick = null; }
  }
  checkExtUpdates(!!force);   // 列表先出，更新检查在后台跑（老板：有更新才显示按钮）
}

/* 启动 / 刷新扩展列表后自动检查更新（npm outdated 纯比对，不真更新）。
   查完：有过期的包挂「更新」按钮 + 显示「全部更新」；全是最新则什么都不挂。
   force=true（点 ↻ 手动刷新）时绕过主进程缓存，真跑一次 npm outdated。 */
async function checkExtUpdates(force) {
  if (!api || !api.checkUpdates) return;
  try {
    const r = await api.checkUpdates(!!force);
    S.extOutdated = new Set(r && Array.isArray(r.outdated) ? r.outdated : []);
  } catch (e) {
    S.extOutdated = new Set();   // 查不了按"没有更新"处理，别让界面卡在检查中
  }
  renderExts();
}
function syncUpdateAllBtn() {
  const b = $('btn-pi-update');
  if (!b) return;
  // 有待更新包才显示「全部更新」；没检查完 / 全是最新 → 藏
  const has = S.extOutdated && S.extOutdated.size > 0;
  b.classList.toggle('hidden', !has);
}
if ($('btn-agents-refresh')) $('btn-agents-refresh').addEventListener('click', () => { S.exts = null; S.extOutdated = null; renderExts(); loadAgents(true); });
// 「全部更新」：pi update --all（pi 本体 + 扩展 + 模型目录，一次到位）
if ($('btn-pi-update')) $('btn-pi-update').addEventListener('click', (e) => updateAllPi(e.currentTarget));

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
  addMsg('step', 'SYS', '&gt; 工作目录已切到 ' + esc(r.dir) + '（@ 引用文件都从这里找）');
}
if ($('btn-pick-dir')) $('btn-pick-dir').addEventListener('click', pickDir);

/* ============================================================
   模型 / 思考档位选择器
   ============================================================ */
const TH_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// 档位显示成中文；传回 pi 的仍是上面的英文内部值（--thinking <lv>）
const TH_ZH = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

function clampLabel(s) {
  return s && s.length > 24 ? s.slice(0, 23) + '…' : s;
}
function modelLabel() {
  if (S.curModel && S.curModel.model) return clampLabel(S.curModel.model);
  // 没手动切过：优先显示"真跑出来的模型"，其次 pi 配置里写的默认。
  // （只说"默认"等于没说 —— 用户真正想知道的就是"现在到底在用哪个模型"。）
  const obs = S.observedModel || (S.piDefault && S.piDefault.model);
  return obs ? clampLabel(obs) : '默认';
}
function modelTitle() {
  if (S.curModel && S.curModel.model) return (S.curModel.provider + '/' + S.curModel.model);
  if (S.observedModel) {
    return '正在用 ' + (S.observedProvider ? S.observedProvider + '/' : '') + S.observedModel +
      '（没手动切过，跟随默认配置）';
  }
  if (S.piDefault && S.piDefault.model) {
    return '默认模型 ' + (S.piDefault.provider ? S.piDefault.provider + '/' : '') + S.piDefault.model;
  }
  return '用默认配置';
}
function paintModelBar() {
  $('kv-model2').textContent = modelLabel();
  $('kv-model2').title = modelTitle();
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
    b.title = lv ? ('--thinking ' + lv + '（' + (TH_ZH[lv] || lv) + '）') : '用默认档位';
    b.addEventListener('click', async () => {
      if (api) { const r = await api.setThinking(lv || null); if (r && r.current) S.curThinking = r.current.thinking; }
      else S.curThinking = lv || null;
      renderThinkBtns();
      paintModelBar();
    });
    box.appendChild(b);
  });
}

/* ---------- 服务商分组的折叠状态（记住，下次打开还是这样） ---------- */
const COLLAPSE_KEY = 'pixelagent.collapsedProvs';
function loadCollapsed() {
  try {
    const j = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(j) ? j.map(String) : []);
  } catch (e) { return new Set(); }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(S.collapsedProvs))); } catch (e) { /* 存不下就算了 */ }
}
S.collapsedProvs = loadCollapsed();   // 注意：S 在上面已经建好，这里只是挂一个集合

function renderModelList(q) {
  const box = $('mdl-list');
  box.innerHTML = '';
  if (!S.collapsedProvs) { S.collapsedProvs = loadCollapsed(); }
  const query = String(q || '').toLowerCase();
  const rows = S.models.filter((m) => !query || (m.provider + '/' + m.model).toLowerCase().includes(query));

  // 分组（保持 pi 给的顺序）
  const provs = [];
  const byProv = {};
  rows.forEach((m) => {
    if (!byProv[m.provider]) { byProv[m.provider] = []; provs.push(m.provider); }
    byProv[m.provider].push(m);
  });
  const collapsed = provs.filter((p) => S.collapsedProvs.has(p));
  const shown = rows.length - collapsed.reduce((a, p) => a + byProv[p].length, 0);

  $('mdl-count').textContent = collapsed.length
    ? (rows.length + ' 个模型 · 收起 ' + collapsed.length + ' 组，正在显示 ' + shown + ' 个')
    : (rows.length + ' 个模型');
  // 标题带上条数（原来写死 `模型()`，一对空括号看着像坏了）。
  $('mdl-title').textContent = '模型(' + rows.length + ')';
  if (!rows.length) { box.appendChild(el('div', 'empty', '没有匹配的模型')); return; }

  provs.forEach((p) => {
    const isCol = S.collapsedProvs.has(p);
    // 分组标题做成真按钮：可点、可 Tab 到、Enter/Space 能开合
    const h = el('button', 'mdl-prov');
    h.type = 'button';
    h.setAttribute('aria-expanded', isCol ? 'false' : 'true');
    h.title = isCol ? '展开这一组' : '收起这一组';
    h.innerHTML = '<span class="mp-caret">' + (isCol ? '▸' : '▾') + '</span>' +
      '<span class="mp-name">' + esc(p) + '</span>' +
      '<span class="mp-n">' + byProv[p].length + '</span>';
    h.title = (isCol ? '展开这一组' : '收起这一组') + '；右键可删除整组';
    h.addEventListener('click', () => {
      if (S.collapsedProvs.has(p)) S.collapsedProvs.delete(p); else S.collapsedProvs.add(p);
      saveCollapsed();
      renderModelList($('mdl-q').value);
    });
    // 右键分组标题 → 删除模型组（老板 2026-10-11 23:00，删除前有确认窗）
    h.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      groupCtxMenu(ev, p);
    });
    box.appendChild(h);
    if (isCol) return;   // 收起 = 不渲染行（不是用 CSS 藏：藏了还在 DOM 里，"数行数"的断言会算进去）

    byProv[p].forEach((m) => {
      const on = S.curModel && S.curModel.provider === m.provider && S.curModel.model === m.model;
      const ctxOv = overrideOfUI(m.provider, m.model);
      const tags = [
        ctxOv && ctxOv.contextTokens ? (fmtTokens(ctxOv.contextTokens) + '*') : m.context,
        m.thinking ? '思考' : '', m.images ? '看图' : ''
      ].filter(Boolean).join(' · ');
      const d = el('div', 'mdl-item' + (on ? ' on' : ''));
      d.innerHTML = '<span class="mi-n">' + esc(m.model) + '</span>' +
        '<span class="mi-tag">' + esc(tags) + '</span>';
      d.title = m.provider + '/' + m.model + ' · 上下文 ' + m.context + ' · 最大输出 ' + m.maxOut +
        (m.images ? ' · 支持看图' : ' · 不支持看图') +
        (ctxOv && ctxOv.contextTokens ? '\n（带 * = 你在配置里覆盖成了 ' + ctxOv.contextTokens + ' 词元）' : '');

      // 老板 2026-10-11 17:44：「模型菜单上的已经配置好了的模型不需要有测试配置」
      // 每一行的「配置 / 测试」按钮都去掉。这两个功能只保留在「新增自定义模型」
      // 那一条链路上（新模型加完需要测连、也常要调整窗口/输出）。
      // 已有的 mi-ops CSS 规则暂时留着不动 —— 不渲染按钮，class 空转而已。

      d.addEventListener('click', async () => {
        if (api) {
          const r = await api.setModel({ provider: m.provider, model: m.model });
          if (r && r.current) S.curModel = r.current.model;
        } else S.curModel = { provider: m.provider, model: m.model };
        paintModelBar();
        renderModelList($('mdl-q').value);
        // 换了模型，上下文窗口（用量条的分母）跟着换
        const ci = ctxInfoOf(m.provider, m.model);
        $('ub-fill').style.width = '0%';
        $('ub-fill').className = '';
        $('ub-text').textContent = '— / ' + ctxLabel(ci);
        $('sb-usage').title = '上下文总窗口 ' + (ci.tokens || '未知') + '\n分母来源：' + ctxSourceZh(ci.source) + '\n（点一下看明细）';
      });
      box.appendChild(d);
    });
  });
  syncCollapseBtn();
}

/* ============================================================
   单个模型的「配置 / 测试」
   ------------------------------------------------------------
   老板原话："点开模型要有配置测试等功能"。
   配置框要回答的第一个问题就是**那个数字从哪来** —— 所以只读区把
   「模型自己声明的」和「pi 报出来的」分两行摆着，不是合成一个数。
   ============================================================ */
const MCFG = { sel: null, info: null, testing: false };

function mcfgOut(text, kind) {
  const o = $('mcfg-out');
  if (!o) return;
  if (!text) { o.className = 'mcfg-out hidden'; o.textContent = ''; return; }
  o.className = 'mcfg-out' + (kind ? ' ' + kind : '');
  o.textContent = text;
}
function mcfgNote(text, bad) {
  const n = $('mcfg-note');
  if (!n) return;
  n.textContent = text || '';
  n.classList.toggle('bad', !!bad);
}

async function openModelConfig(m, runTest) {
  const sel = { provider: m.provider, model: m.model };
  MCFG.sel = sel; MCFG.info = null;
  $('mcfg-title').textContent = '模型配置(' + m.model + ')';
  $('mcfg-id').textContent = m.model;
  $('mcfg-prov').textContent = m.provider;
  $('mcfg-base').textContent = '读取中…';
  $('mcfg-reported').textContent = '—';
  $('mcfg-cap').textContent = '—';
  $('mcfg-auth').textContent = '—';
  $('mcfg-ctx').value = '';
  $('mcfg-max').value = '';
  $('mcfg-ctx').placeholder = m.context || '—';
  $('mcfg-max').placeholder = m.maxOut || '—';
  mcfgNote('');
  mcfgOut('');
  $('mcfg-default').disabled = false;
  $('mask-mcfg').classList.remove('hidden');

  if (!api) {
    $('mcfg-base').textContent = '（演示模式没有主进程）';
    return;
  }
  const info = await api.modelInfo(sel);
  if (!info || info.ok === false) {
    $('mcfg-base').textContent = '读取失败：' + ((info && info.error) || '未知原因');
    return;
  }
  MCFG.info = info;
  $('mcfg-base').textContent = info.baseUrl
    ? (info.baseUrl + (info.api ? '（' + info.api + '）' : ''))
    : '没在配置里声明';

  // ★ 这个数字到底是"模型自己说的"还是"pi 补的"，在这里分开说清楚
  const rep = info.reported;
  const dec = info.declared;
  const src = dec && dec.contextWindow ? '模型自己声明的' : '模型没声明 → 内置兜底值';
  $('mcfg-reported').textContent = rep
    ? (rep.context + '（' + rep.contextTokens + ' 词元）· 最大输出 ' + rep.maxOut + '  ← ' + src)
    : '内置表里没有这个模型';

  const caps = [];
  if (rep) {
    caps.push(rep.thinking ? '可开思考' : '不支持思考');
    caps.push(rep.images ? '能看图' : '不能看图');
  }
  if (dec && dec.input && dec.input.length) caps.push('声明输入：' + dec.input.join('+'));
  $('mcfg-cap').textContent = caps.length ? caps.join(' · ') : '—';
  $('mcfg-auth').textContent = info.hasKey
    ? '已配置密钥（内容不回显）'
    : '没在 models.json 里找到 key';

  if (info.override) {
    if (info.override.contextTokens) $('mcfg-ctx').value = String(info.override.contextTokens);
    if (info.override.maxOut) $('mcfg-max').value = String(info.override.maxOut);
  }
  if (info.isDefault) {
    $('mcfg-note').textContent = '这是默认模型。';
    $('mcfg-default').disabled = true;
  }
  if (runTest) runModelTest();
}

function closeModelConfig() {
  $('mask-mcfg').classList.add('hidden');
  MCFG.sel = null;
}

async function runModelTest() {
  if (!api || !MCFG.sel || MCFG.testing) return;
  MCFG.testing = true;
  $('mcfg-test').disabled = true;
  mcfgOut('正在真发一次最小请求…（会让这个模型回一句 OK，耐心等）', 'busy');
  const t0 = Date.now();
  let r = null;
  try { r = await api.modelTest(MCFG.sel); } catch (e) { r = { ok: false, error: String(e && e.message) }; }
  MCFG.testing = false;
  $('mcfg-test').disabled = false;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!r) { mcfgOut('测试没有返回结果（用时 ' + secs + ' 秒）', 'bad'); return; }
  if (!r.ok) {
    mcfgOut('❌ 不通（用时 ' + secs + ' 秒）\n' + (r.error || '未知原因') +
      (r.raw ? '\n\n原始输出尾部：\n' + r.raw : ''), 'bad');
    return;
  }
  mcfgOut('✅ 通了\n' +
    '模型回话：' + JSON.stringify(r.text) + '\n' +
    '服务商实际用的模型：' + (r.responseModel || '未报告') + '\n' +
    '报告耗时：' + (r.durationMs || 0) + ' ms（我这里量到 ' + secs + ' 秒，含启动）\n' +
    '这一轮的 token：总 ' + (r.totalTokens || 0) + '（入 ' + (r.inputTokens || 0) +
    ' / 出 ' + (r.outputTokens || 0) + '）\n' +
    '结束原因：' + (r.stopReason || '未报告'), 'ok');
}

async function saveModelConfig() {
  if (!api || !MCFG.sel) return;
  const cRaw = $('mcfg-ctx').value.trim();
  const xRaw = $('mcfg-max').value.trim();
  const ctx = cRaw === '' ? 0 : Math.round(Number(cRaw));
  const max = xRaw === '' ? 0 : Math.round(Number(xRaw));
  if (cRaw !== '' && (!Number.isFinite(ctx) || ctx <= 0)) { mcfgNote('上下文窗口要填正整数（或留空用默认值）', true); return; }
  if (xRaw !== '' && (!Number.isFinite(max) || max <= 0)) { mcfgNote('最大输出要填正整数（或留空用默认值）', true); return; }
  // 覆盖值那张表由**主进程**持有并落盘（它是唯一写盘的一方），
  // 这里只把"这一次要改成什么"发过去。之前这里还自己拼了一份 `patch` 却从不发送 ——
  // 看着像在改配置、其实一行都没用上，这种"看着有用其实没用"的死代码比没有更危险。
  const r = await api.setModelConfig(Object.assign({}, MCFG.sel, { contextTokens: ctx, maxOut: max, clear: (!ctx && !max) }));
  const dropped = (r && r.droppedKeys) || [];
  // 这条**必须**留着：它是唯一能拦住"保存了但没落盘"的哨兵。
  // 上一轮真出过事 —— 主进程把 modelOverrides 整张表当配置补丁收，
  // 白名单一个顶层键都匹配不上，值全丢；界面只看到"没报错"。
  if (dropped.length) { mcfgNote('主进程不认识的键：' + dropped.join(', '), true); return; }
  if (r && r.ok === false) { mcfgNote('保存失败：' + ((r && r.error) || '未知原因'), true); return; }
  if (r && r.cfg) applyCfg(r.cfg, null);
  mcfgNote((!ctx && !max) ? '已清掉这个模型的覆盖值，回到默认值。' : '已保存：用量条的分母按你填的值算。');
  // 立刻把用量条按新分母重算，不用等下一轮
  if (S.lastUsage) setUsage(S.lastUsage, S.lastUsageModel);
  else paintCtxIdle();
  renderModelList($('mdl-q').value);
  setTimeout(() => { if (!$('mask-mcfg').classList.contains('hidden')) closeModelConfig(); }, 700);
}

async function setAsDefaultModel() {
  if (!api || !MCFG.sel) return;
  const full = MCFG.sel.provider + '/' + MCFG.sel.model;
  const r = await api.setCfg({ defaultModel: full });
  if (r && r.ok) {
    mcfgNote('已设为默认模型：' + full + '（下次启动用它；当前这一轮也切过去了）');
    $('mcfg-default').disabled = true;
    if (r.cfg) applyCfg(r.cfg, null);
    const mm = await api.models();
    if (mm && mm.current) { S.curModel = mm.current.model; S.piDefault = mm.current.piDefault || S.piDefault; }
    paintModelBar();
    renderModelList($('mdl-q').value);
  } else mcfgNote('设为默认失败', true);
}

async function openModelPicker() {
  $('mask-model').classList.remove('hidden');
  renderThinkBtns();
  if (!api) { renderModelList(''); return; }
  if (!S.modelsLoaded) {
    $('mdl-count').textContent = '读取中…';
    $('mdl-title').textContent = '模型(读取中)';
    const r = await api.models();
    if (r && r.ok && r.models && r.models.length) {
      S.models = r.models;
      S.modelsLoaded = true;
      if (r.current) {
        S.curModel = r.current.model;
        S.curThinking = r.current.thinking;
        S.piDefault = r.current.piDefault || S.piDefault;
      }
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

/* ---------- 新增自定义模型 ----------
   老板 2026-10-11：模型菜单要有"新增自定义模型"入口。
   流程：
     ① 打开对话框 → 填充服务商 datalist（从 S.models 现取，避免手写漂）
     ② 保存 → 调 api.addModel → 主进程写 models.json → 清 modelsCache
     ③ 主进程写完缓存清了，本地还得清一次：S.models=[]; S.modelsLoaded=false
     ④ 重新走 openModelPicker 拉一次模型目录，界面就能看到新加的
   主进程会拒绝的几种情况（renderer 直接显示主进程回的 error）：
     - provider 或 modelId 空
     - 同 provider 下已有同名 modelId（避免静默覆盖）
     - 上下文窗口/最大输出不是正整数
   服务商留空 base URL / apiKey 的行为：主进程只覆盖填了的字段，
     空字符串不动已有配置 —— 用户想改 key，就把新值填进来；不填就保留。 */

function maddNote(text, bad) {
  const n = $('madd-note');
  if (!n) return;
  n.textContent = text || '';
  n.style.color = bad ? 'var(--warn)' : '';
  if (bad) n.classList.add('bad'); else n.classList.remove('bad');
}

function fillMaddProviders() {
  const dl = $('madd-prov-list');
  if (!dl) return;
  dl.innerHTML = '';
  const names = new Set();
  (S.models || []).forEach((m) => { if (m.provider) names.add(m.provider); });
  // 也看看主进程 models.json 里的 provider（models 表里有的都在 S.models 里，
  // 但兜底再加一次不亏）
  names.forEach((name) => {
    const o = document.createElement('option');
    o.value = name;
    dl.appendChild(o);
  });
}

function fillMaddModels(models) {
  // 把 fetch-provider-models 拉回来的模型列表塞进 <select>。
  // 老板 2026-10-12：这个下拉只是「选一个来测试/当默认」，保存时**整组**都会入组，
  // 不再是"选了哪个就只加哪个"。
  const sel = $('madd-model');
  if (!sel) return;
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = models && models.length
    ? '— 选一个测试用（保存时 ' + models.length + ' 个全部入组） —'
    : '— 先点「获取模型列表」 —';
  sel.appendChild(ph);
  (models || []).forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.id;
    sel.appendChild(o);
  });
  // 「添加」按钮跟着列表长度走：没拉列表就还是"添加"，拉到了就明说整组数量
  const save = $('madd-save');
  if (save) {
    save.textContent = (models && models.length)
      ? '添加全部 ' + models.length + ' 个模型'
      : '添加';
  }
}

// 拉 provider 的模型列表：填 base + key，点一下
async function fetchMaddModels() {
  const base = $('madd-base').value.trim();
  const key = $('madd-key').value.trim();
  const btn = $('madd-fetch');
  if (!base) { maddNote('先填接入地址', true); return; }
  if (!key) { maddNote('先填 API Key', true); return; }
  btn.disabled = true;
  btn.textContent = '正在获取…';
  maddNote('正在从服务商拉模型列表…');
  let r = null;
  try {
    r = await api.fetchProviderModels({ baseUrl: base, apiKey: key });
  } catch (e) {
    maddNote('请求出错：' + ((e && e.message) || e), true);
  }
  btn.disabled = false;
  btn.textContent = '获取模型列表';
  if (!r || r.ok === false) {
    maddNote('获取失败：' + ((r && r.error) || '未知原因'), true);
    fillMaddModels([]);
    return;
  }
  // 缓存下来：saveModelAdd 时 ctx/max 从这里带（provider 元数据里没有就 0，pi 自己兜底）
  S.maddFetchedModels = (r.models || []).map((m) => ({
    id: m.id,
    contextWindow: Number(m.contextWindow) || 0,
    maxTokens: Number(m.maxTokens) || 0
  }));
  fillMaddModels(S.maddFetchedModels);
  const n = (r.models || []).length;
  maddNote('拿到 ' + n + ' 个模型 —— 保存时这 ' + n + ' 个会全部加进「' +
    ($('madd-provider').value.trim() || '新服务商') + '」组。可以选一个先测试连通。');
}

// 测试连通：填 base + key + 模型 ID，发一次 max_tokens=1 的最小请求
async function runMaddTest() {
  const base = $('madd-base').value.trim();
  const key = $('madd-key').value.trim();
  const modelId = $('madd-model').value;
  const btn = $('madd-test');
  if (!base) { maddNote('先填接入地址', true); return; }
  if (!key) { maddNote('先填 API Key', true); return; }
  if (!modelId) { maddNote('先从下拉里选一个模型 ID', true); return; }
  btn.disabled = true;
  btn.textContent = '正在测试…';
  maddNote('正在发一次最小请求（max_tokens=1）…');
  let r = null;
  try {
    r = await api.testConnection({ baseUrl: base, apiKey: key, modelId });
  } catch (e) {
    maddNote('请求出错：' + ((e && e.message) || e), true);
  }
  btn.disabled = false;
  btn.textContent = '测试连通';
  if (!r || r.ok === false) {
    maddNote('❌ 没通：' + ((r && r.error) || '未知原因'), true);
    return;
  }
  maddNote('✅ 通了（' + r.ms + 'ms，回复「' + (r.text || '').slice(0, 30) + '」）');
}

function openModelAdd() {
  if (!api) return;
  $('madd-provider').value = '';
  $('madd-base').value = '';
  $('madd-key').value = '';
  fillMaddModels([]);
  S.maddFetchedModels = [];
  maddNote('');
  fillMaddProviders();
  $('madd-fetch').disabled = false;
  $('madd-fetch').textContent = '获取模型列表';
  $('madd-test').disabled = false;
  $('madd-test').textContent = '测试连通';
  $('mask-model-add').classList.remove('hidden');
  setTimeout(() => $('madd-provider').focus(), 50);
}

function closeModelAdd() { $('mask-model-add').classList.add('hidden'); }

async function saveModelAdd() {
  if (!api) return;
  const provider = $('madd-provider').value.trim();
  const baseUrl = $('madd-base').value.trim();
  const apiKey = $('madd-key').value.trim();
  // 老板 2026-10-12：服务商返回的几个模型就加几个，不再只加选中的那一个。
  // 下拉里选的那一个只是「测试用 / 默认想看的那一个」，不参与"加哪些"的筛选。
  const picked = $('madd-model').value;
  const all = (S.maddFetchedModels || []).filter((m) => m && m.id);
  if (!provider) { maddNote('服务商必填', true); return; }
  if (!all.length) {
    maddNote('先点「获取模型列表」把服务商的模型拉下来（拉到几个就加几个）', true);
    return;
  }
  if (!baseUrl) { maddNote('接入地址必填', true); return; }
  if (!apiKey) { maddNote('API Key 必填（新服务商）', true); return; }

  maddNote('正在写入 ' + all.length + ' 个模型…');
  const r = await api.addModels({
    provider,
    baseUrl,
    apiKey,
    models: all,
    defaultModelId: picked || all[0].id
  });
  if (!r || r.ok === false) {
    maddNote('添加失败：' + ((r && r.error) || '未知原因'), true);
    return;
  }
  // 清本地缓存，逼下一次 pi:models 重跑
  S.models = [];
  S.modelsLoaded = false;
  const added = (r.added || []).length;
  const skipped = (r.skipped || []).length;
  let msg = '已把 ' + added + ' 个模型加进「' + provider + '」组（共 ' + (r.total || added) + ' 个）';
  if (skipped) msg += '，' + skipped + ' 个本来就在组里（跳过）';
  maddNote(msg);
  setTimeout(async () => {
    closeModelAdd();
    // 强制刷新模型菜单：openModelPicker 会重新拉一次
    if (!$('mask-model').classList.contains('hidden')) {
      // modelsLoaded=false 会让 openModelPicker 重新走读取路径
      await openModelPicker();
    }
  }, 900);
}

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

// 老板 2026-10-11 定的规矩：命令面板只留"点按钮做不了"的。
// 之前有 14 条，其中 /tools /todos /files /agents /search /settings /info 七条
// 都是"右栏 tab / 左栏按钮 / 搜索框 focus"能直接点出来的 —— 留着只会让人以为
// 得记命令才行。删掉后剩 7 条，都是有实际入口差异的：
// - /rename /export /clear：功能上有（改名要参数、导出有格式），但会话条按钮不覆盖
// - /new /stop /img /dir：状态栏或按钮上有类似的，但保留是因为
//   「按一次」比「找按钮」快（老板说保留，尊重老板）
const COMMANDS = [
  { k: '/new',    g: '会话', d: '新建会话（清空上下文）',       run: () => newSession() },
  { k: '/rename', g: '会话', d: '给当前会话改名', arg: '名字',   run: (a) => renameCurrent(a) },
  { k: '/export', g: '会话', d: '导出当前会话（格式见设置）',   run: () => exportSession({ seq: S.seq, title: '当前会话' }) },
  { k: '/clear',  g: '会话', d: '清空当前视图（不动会话文件）', run: () => { log.innerHTML = ''; if (welcome) welcome.classList.remove('hidden'); } },
  { k: '/stop',   g: '运行', d: '停止当前这一轮',                run: () => doAbort() },
  { k: '/img',    g: '输入', d: '添加附件（图片/文档都行，也可直接粘贴/拖拽）', run: () => filePicker.click() },
  { k: '/dir',    g: '输入', d: '切换工作目录',                  run: () => pickDir() }
];

// 老板 2026-10-11 17:44：/ 命令面板不弹了，验收要能直接读命令表；
// 不然"是否真的没有 /model"只能靠 UI 弹面板去看 —— 而面板现在根本不弹。
// 声明在 COMMANDS 常量之后（`const` 有 TDZ，早了会抛错把下面所有代码一起断掉）。
window.__pixelCommands = COMMANDS.map((c) => ({ k: c.k, g: c.g, d: c.d, argTip: c.argTip || '' }));

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

  // 老板 2026-10-11 17:44：`/` 命令菜单整个不弹了 —— 都鼠标可点，冗余。
  // 但 `/` 命令本身保留（在 send() 里直接执行），用户可以敲 /new、/rename foo 直接跑。
  if (v.startsWith('/')) { closePalette(); return; }

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
    // 浮层谁开着就该谁吃掉 Esc —— 否则会掉到下面的 doAbort()，
    // 把"想关掉浮层"变成"把正在跑的这轮中断掉"（README 坑 19）。
    // ★★ 但"谁该吃"必须是**盖在最上面的那一个**，手写判断顺序会漂：
    //    这一轮就是活例子 —— mask-mcfg 这支排在 mask-model **后面**，
    //    于是"模型框 + 配置框"双层开着时按 Esc，关掉的是**下面**那个模型框，
    //    最上面的配置框纹丝不动（用户按了 Esc 却像没反应）。
    //    ⇒ 别手写顺序，直接从 DOM 里挑：同层浮层 z-index 一样，
    //      DOM 里越靠后越在上面（"两张截图字节数完全相同"就是因为这个）。
    const top = ['mask-input', 'mask', 'mask-model', 'mask-mcfg', 'mask-model-add']
      .map((id) => $(id))
      .filter((m) => m && !m.classList.contains('hidden'))
      // 降序：DOM 里越靠后越在上面（z-index 相同），所以 [0] 就是最上面那一层。
      // ⚠ 第一次写成 `? -1 : 1` 得到的是 ascending ⇒ [0] 是 DOM 里最**前**的
      //   （也就是最下面那层），于是双层时又关错了目标 —— 同一条 bug 换个写法重犯。
      .sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? 1 : -1))[0];
    if (top) {
      if (top.id === 'mask-input') closeInput(false);
      else if (top.id === 'mask-model') closeModelPicker();
      else if (top.id === 'mask-mcfg') closeModelConfig();
      else if (top.id === 'mask-model-add') closeModelAdd();
      else closeSettings(true);
      return;
    }
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
  const em = effModel();
  const ci = ctxInfoOf(em && em.provider, em && em.model);
  $('ub-fill').style.width = '0%';
  $('ub-fill').className = '';
  $('ub-text').textContent = '— / ' + ctxLabel(ci);
});

/* ---------- 模型列表：全部展开 / 全部收起 ---------- */
/* 模型组右键菜单（老板 2026-10-11 23:00：右键分组标题 → 删除模型组 → 确认窗） */
function closeGroupCtx() {
  const m = document.querySelector('.ctx-menu');
  if (m) m.remove();
}
function groupCtxMenu(ev, prov) {
  closeGroupCtx();
  const m = el('div', 'ctx-menu');
  const del = el('button', 'ctx-item');
  del.type = 'button';
  del.textContent = '删除模型组';
  del.addEventListener('click', () => { closeGroupCtx(); removeModelGroup(prov); });
  m.appendChild(del);
  document.body.appendChild(m);
  // 贴着鼠标出菜单，贴屏幕边时往回缩
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - r.height - 8)) + 'px';
  // 点菜单外任何地方 / 再按一次右键 → 收掉
  setTimeout(() => {
    document.addEventListener('mousedown', closeGroupCtx, { once: true });
    document.addEventListener('contextmenu', closeGroupCtx, { once: true });
  }, 0);
}
async function removeModelGroup(prov) {
  if (!api) return;
  const n = S.models.filter((x) => x.provider === prov).length;
  const ok = await confirmBox(
    '删除模型组',
    '把模型组「' + prov + '」整个删掉？\n\n组里 ' + n + ' 个模型会被移除，这一组的密钥配置也一起删。\n直接改配置文件，不进回收站。'
  );
  if (!ok) return;
  const r = await api.removeModelGroup(prov);
  if (!r || r.ok !== true) { toast('删除失败：' + ((r && r.error) || '未知原因')); return; }
  // 当前用的模型在被删组里 → 切回 pi 默认（动作和「恢复默认」按钮一致）
  if (S.curModel && S.curModel.provider === prov) {
    const rr = await api.setModel(null);
    if (rr && rr.current) S.curModel = rr.current.model;
    const em = effModel();
    const ci = ctxInfoOf(em && em.provider, em && em.model);
    $('ub-fill').style.width = '0%';
    $('ub-fill').className = '';
    $('ub-text').textContent = '— / ' + ctxLabel(ci);
  }
  // 重拉模型目录 + 重画列表（重拉失败也不影响提示删除成功）
  const m = await api.models();
  if (m && m.ok && m.models) { S.models = m.models; S.modelsLoaded = true; }
  renderModelList($('mdl-q').value);
  paintModelBar();
  updateVision();
  renderAtt();
  toast('模型组「' + prov + '」已删除（' + (r.removed || 0) + ' 个模型）');
}

function allProvs(q) {
  const query = String(q == null ? $('mdl-q').value : q).toLowerCase();
  return Array.from(new Set(S.models
    .filter((m) => !query || (m.provider + '/' + m.model).toLowerCase().includes(query))
    .map((m) => m.provider)));
}
function syncCollapseBtn() {
  const btn = $('mdl-collapse');
  if (!btn) return;
  const all = allProvs('');
  const coll = all.filter((p) => S.collapsedProvs.has(p)).length;
  btn.textContent = (all.length && coll === all.length) ? '全部展开' : '全部收起';
  btn.title = (all.length && coll === all.length)
    ? '把所有服务商分组都展开'
    : '把所有服务商分组都收起（收起状态会记住）';
}
$('mdl-collapse').addEventListener('click', () => {
  const all = allProvs('');
  const coll = all.filter((p) => S.collapsedProvs.has(p)).length;
  if (all.length && coll === all.length) S.collapsedProvs.clear();
  else all.forEach((p) => S.collapsedProvs.add(p));
  saveCollapsed();
  renderModelList($('mdl-q').value);
});

/* ---------- 模型配置 / 测试对话框 ---------- */
$('mcfg-x').addEventListener('click', closeModelConfig);
$('mcfg-cancel').addEventListener('click', closeModelConfig);
$('mask-mcfg').addEventListener('click', (e) => { if (e.target === $('mask-mcfg')) closeModelConfig(); });
$('mcfg-save').addEventListener('click', saveModelConfig);
$('mcfg-test').addEventListener('click', runModelTest);
$('mcfg-default').addEventListener('click', setAsDefaultModel);

// 新增自定义模型
$('mdl-add').addEventListener('click', openModelAdd);

$('madd-x').addEventListener('click', closeModelAdd);
$('madd-cancel').addEventListener('click', closeModelAdd);
$('madd-save').addEventListener('click', saveModelAdd);
$('madd-fetch').addEventListener('click', fetchMaddModels);
$('madd-test').addEventListener('click', runMaddTest);
// 选了模型后自动从缓存带 ctx/max（用户不手填，保存时从 S.maddFetchedModels 读）
$('madd-model').addEventListener('change', () => {
  const sel = $('madd-model').value;
  S.maddSelectedHit = ((S.maddFetchedModels || []).find((m) => m.id === sel)) || null;
});
// 暴露给测试用（UI 入口已移除，测试直接调用打开 mcfg）
window.__openModelConfig = openModelConfig;
window.__effModel = effModel;
window.__models = () => S.models;
$('mask-model-add').addEventListener('click', (e) => { if (e.target === $('mask-model-add')) closeModelAdd(); });

/* ---------- 点用量条 → 看上下文明细（把"这个数字从哪来"说清楚） ---------- */
if ($('sb-usage')) {
  $('sb-usage').addEventListener('click', showUsageDetail);
  $('sb-usage').style.cursor = 'pointer';
}
// 老板 2026-10-13：「加个缓存命中到最下方栏」—— 点缓存那一格也看明细
// （明细里现在有「缓存命中」一行：读/写/新输入分别多少）。
if ($('sb-cache')) {
  $('sb-cache').addEventListener('click', showUsageDetail);
  $('sb-cache').style.cursor = 'pointer';
}

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
  // 界面字号三档 → body class（CSS 变量 --fs-base 一处生效）
  document.body.classList.toggle('fs-s', CFG.fontSize === 's');
  document.body.classList.toggle('fs-xs', CFG.fontSize === 'xs');
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

/* 设置面板里的分段按钮（.seg 里的 .seg-b）：点一下切 .on + 即时预览。
   ★ 为什么要委托：set-enter / set-export 这两个 seg 从来没绑过点击 ——
     点了不切换，保存时 segPick 读到的还是初始 .on（功能是坏的，只是没人发现）。
     加 persona seg（老板 2026-10-12）时统一收在这里：以后加 seg 都不用再管绑定。
   .sw 是主题色色块（buildAccentSeg 自建、自带点击），跳过别重复执行。 */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const b = t.closest('.seg:not(.sw) .seg-b');
  if (!b) return;
  segOn(b.parentElement, b.dataset.v);
  previewDraftCfg();
});

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
  // 「默认模型」下拉已删（老板 2026-10-11 23:00 图二去掉）：
  // 设默认模型走模型配置窗口里的「设为默认模型」按钮，设置面板不再重复一份。
  // c.defaultModel 保留在配置里，formToCfg 会原样带回去，绝不能悄悄清掉。
  $('set-thinking').value = c.defaultThinking || '';
  $('set-maximg').value = String(c.maxImages == null ? 4 : c.maxImages);
  $('set-mascot').checked = c.mascotAnim !== false;
  $('set-compact').checked = c.compact === true;
  $('set-scroll').checked = c.autoScroll !== false;
  // 老板 2026-10-13：桌面提醒（默认开）。老配置里没这个键 → 主进程 normalizeCfg
  // 会补默认值 true，所以这里 !== false 的判据是对的。
  if ($('set-notify')) $('set-notify').checked = c.desktopNotify !== false;
  segOn($('set-enter'), c.enterToSend === false ? '0' : '1');
  segOn($('set-export'), c.exportFormat || 'md');   // 老板 2026-10-12：默认 MD
  segOn($('set-accent'), c.accent || 'lav');
  // 老板 2026-10-12：用户画像 + 像素性格
  $('set-uname').value = c.userName || '';
  $('set-uprofile').value = c.userProfile || '';
  segOn($('set-persona'), c.persona || 'lively');
  segOn($('set-fsize'), c.fontSize || 's');   // 老板 2026-10-13：界面字号三档，默认小
}

function formToCfg() {
  return {
    workDir: $('set-cwd').value.trim(),
    // 默认模型下拉已删：沿用配置里的现值，保存时绝不覆盖（上面 cfgToForm 的说明）
    defaultModel: (CFG && CFG.defaultModel) || '',
    defaultThinking: $('set-thinking').value,
    maxImages: Number($('set-maximg').value),
    mascotAnim: $('set-mascot').checked,
    compact: $('set-compact').checked,
    fontSize: segPick($('set-fsize')) || 's',
    autoScroll: $('set-scroll').checked,
    desktopNotify: $('set-notify') ? $('set-notify').checked : true,
    enterToSend: segPick($('set-enter')) === '1',
    exportFormat: segPick($('set-export')) || 'md',   // 老板 2026-10-12：默认 MD
    accent: segPick($('set-accent')) || 'lav',
    // 老板 2026-10-12：用户画像 + 像素性格（trim/长度夹在主进程 normalizeCfg 里做）
    userName: $('set-uname').value,
    userProfile: $('set-uprofile').value,
    persona: segPick($('set-persona')) || 'lively'
  };
}

// 主题色 / 动画 / 紧凑 这类"看得见"的先即时预览，取消时再整个回滚。
// 像素性格也算"看得见"：切了立刻用新腔调冒一句，不用保存就能听出差别。
function previewDraftCfg() {
  const d = formToCfg();
  // fontSize 也要在这儿：seg 的即时预览走的是这个白名单，
  // 漏了就会出现"点了『更小』没反应、保存后才有变化"（设置项最容易漏的一处接线）。
  applyCfg(Object.assign({}, CFG, {
    accent: d.accent, mascotAnim: d.mascotAnim, compact: d.compact,
    persona: d.persona, fontSize: d.fontSize
  }));
  if (d.persona && d.persona !== S.personaPreviewed) {
    S.personaPreviewed = d.persona;
    girlSay(pickLine('IDLE'), 2600);   // 用新性格的词库打招呼
  }
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
    // 模型目录：模型对话框要用（默认模型下拉已删，这里只为 S.models 拉数据）
    if (!S.models.length) {
      api.models().then((r) => {
        if (r && r.ok && r.models) { S.models = r.models; S.modelsLoaded = true; }
        cfgToForm(CFG);
      }).catch(() => { cfgToForm(CFG); });
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
  $('set-cli').textContent = i.cli || '未安装';
  $('set-session').textContent = i.session;
  $('set-mode').textContent = i.mode;
  $('set-agentdir').textContent = i.agentDir || '—';
  const st = i.agentDirState || {};
  $('set-auth').textContent = st.ready
    ? '就绪'
    : ('未就绪：' + (st.error || '未知'));
  // 没手动切过模型时报的是 null —— 这时把配置里的默认模型写出来，
  // 否则这一行只会说"（默认）"，用户不知道到底用的是哪个。
  const pd = i.current && i.current.piDefault;
  $('set-curmodel').textContent = i.current && i.current.model
    ? (i.current.model.provider + '/' + i.current.model.model)
    : (i.cli === null ? '未安装'
      : (pd ? (pd.model + '（默认' + (pd.provider ? '，来自 ' + pd.provider : '') + '）') : '（默认）'))
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
  if (api.models) api.models().then((r) => { if (r && r.ok && r.models) { S.models = r.models; S.modelsLoaded = true; cfgToForm(CFG); } }).catch(() => {});
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
   时钟 + 窗外天色（老板 2026-10-11：窗户按右下角时间分五档）
   morning 5-9 / noon 9-13 / afternoon 13-18 / evening 18-23 / night 23-5
   ============================================================ */
function timeSeg(h) {
  if (h >= 5 && h < 9) return 'morning';
  if (h >= 9 && h < 13) return 'noon';
  if (h >= 13 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'night';
}
function tick() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  $('sb-clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const win = $('of-window');
  if (win) win.dataset.time = timeSeg(d.getHours());
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
   首次运行引导：主进程说 firstRun（没有 auth.json、models.json
   里也没配过密钥）就盖欢迎窗 —— 填 接入地址 + Key → 拉模型列表
   → 真发一次测试请求 → 通过才落盘 addModel。跳过 = 下次启动再问。
   ============================================================ */
let wlShown = false;
function showWelcome() {
  if (wlShown || !api) return;
  const w = $('wl-overlay');
  if (!w) return;
  wlShown = true;
  w.classList.remove('hidden');
}
function hideWelcome() {
  const w = $('wl-overlay');
  if (w) w.classList.add('hidden');
}
function wlMsg(text, bad) {
  const m = $('wl-msg');
  if (!m) return;
  m.classList.remove('hidden');
  m.textContent = text;
  m.classList.toggle('bad', !!bad);
}
function wlBusy(on) {
  const b = $('wl-save'), f = $('wl-fetch');
  if (b) { b.disabled = on; b.textContent = on ? '测试中…' : '测试并保存'; }
  if (f) f.disabled = on;
}
async function welcomeSave() {
  if (!api) return;
  const base = $('wl-base').value.trim();
  const key = $('wl-key').value.trim();
  const manual = $('wl-model-manual');
  const fromList = $('wl-model').value.trim();
  const modelId = (manual && !manual.classList.contains('hidden'))
    ? manual.value.trim()
    : fromList;
  if (!base) { wlMsg('先填接入地址', true); return; }
  if (!key) { wlMsg('先填 API Key', true); return; }
  if (!modelId) { wlMsg('先选一个模型（列表里没有就点「手动填模型 ID」）', true); return; }

  wlBusy(true);
  try {
    wlMsg('正在真发一次测试请求（几秒钟）…');
    const t = await api.testConnection({ baseUrl: base, apiKey: key, modelId });
    if (!t || !t.ok) {
      wlMsg('测试没通过：' + ((t && t.error) || '未知原因') + ' —— 检查地址 / Key / 模型 ID 再试', true);
      return;
    }
    wlMsg('测试通过（' + (t.ms || '?') + 'ms），正在保存配置…');
    const r = await api.addModel({ provider: 'custom', modelId, baseUrl: base, apiKey: key, allowUpdate: true });
    if (!r || !r.ok) { wlMsg('保存失败：' + ((r && r.error) || '未知原因'), true); return; }
    wlMsg('配置完成，开始用吧！');
    setTimeout(hideWelcome, 500);
    // 模型目录重拉（新模型刚落盘）+ 用量条切到刚配的模型
    api.models().then((rr) => {
      if (rr && rr.ok && rr.models) {
        S.models = rr.models; S.modelsLoaded = true;
        S.curModel = { provider: 'custom', model: modelId };
        paintModelBar();
      }
    }).catch(() => {});
  } catch (e) {
    wlMsg('出错：' + ((e && e.message) || e), true);
  } finally {
    wlBusy(false);
  }
}
if ($('wl-overlay')) {
  $('wl-save').addEventListener('click', welcomeSave);
  $('wl-skip').addEventListener('click', hideWelcome);
  const wlToggleManual = (force) => {
    const m = $('wl-model-manual');
    if (!m) return;
    m.classList.toggle('hidden', typeof force === 'boolean' ? !force : undefined);
    const t = $('wl-toggle-manual');
    if (t) t.textContent = m.classList.contains('hidden') ? '列表里没有？手动填模型 ID' : '改回从列表选';
  };
  $('wl-toggle-manual').addEventListener('click', () => wlToggleManual());
  $('wl-fetch').addEventListener('click', async () => {
    const base = $('wl-base').value.trim();
    const key = $('wl-key').value.trim();
    if (!base || !key) { wlMsg('拉取模型前，先填好接入地址和 API Key', true); return; }
    wlMsg('正在拉取模型列表…');
    const r = await api.fetchProviderModels({ baseUrl: base, apiKey: key });
    if (!r || !r.ok) { wlMsg('拉取失败：' + ((r && r.error) || '未知原因'), true); return; }
    const sel = $('wl-model');
    sel.innerHTML = '';
    (r.models || []).forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.id;
      sel.appendChild(o);
    });
    if (!r.models || !r.models.length) {
      sel.innerHTML = '<option value="">接口没报模型清单</option>';
      wlToggleManual(true);
      wlMsg('接口没吐出模型清单 —— 已切到手动填模型 ID', true);
      return;
    }
    wlMsg('拉到 ' + r.models.length + ' 个模型，选一个');
  });
}

/* ============================================================
   自我扫描体检（老板 2026-10-13：「我让她自己扫描自己，发现很多的缺失」）
   ------------------------------------------------------------
   主进程 pi:doctor 逐项实测（模型配置/运行时/扩展/目录可写/工作目录/网络），
   这里只负责画成一张清单。欢迎页和设置面板共用同一个对话框 ——
   「精装房」的验收标准就一条：新用户照着这份清单，每项都能自己修好。
   ============================================================ */
const DOC_ST = { ok: '正常', warn: '要注意', fail: '缺失' };
async function runDoctor() {
  const list = $('doctor-list');
  const tip = $('doctor-tip');
  if (!list) return;
  list.innerHTML = '<div class="empty">正在扫描这台机器（几秒钟）…</div>';
  if (tip) tip.textContent = '';
  $('mask-doctor').classList.remove('hidden');

  let r = null;
  try { r = api ? await api.doctor() : null; } catch (e) { r = null; }
  if (!r || !r.ok || !Array.isArray(r.items)) {
    list.innerHTML = '<div class="empty bad">体检没跑起来：' + esc((r && r.error) || '主进程没响应') + '</div>';
    return;
  }
  list.innerHTML = '';
  r.items.forEach((x) => {
    const d = el('div', 'doc-item ' + esc(x.state || 'warn'));
    d.innerHTML =
      '<span class="doc-ic">' + (x.state === 'ok' ? '✅' : x.state === 'fail' ? '❌' : '⚠️') + '</span>' +
      '<span class="doc-body">' +
        '<span class="doc-name">' + esc(x.name) + ' · ' + esc(DOC_ST[x.state] || x.state) + '</span>' +
        '<span class="doc-detail">' + esc(x.detail || '') + '</span>' +
        (x.fix ? '<span class="doc-fix">怎么补：' + esc(x.fix) + '</span>' : '') +
      '</span>';
    list.appendChild(d);
  });
  if (tip) {
    const bad = r.items.filter((x) => x.state !== 'ok').length;
    tip.textContent = bad
      ? ('有 ' + bad + ' 项要注意/缺失 —— 照着「怎么补」逐项处理就行')
      : '全部正常，这台机器可以直接用';
  }
  // 体检入口（验收读这个判断"对话框开没开"）
  window.__pixelDoctor = { open: true, ready: r.ready, items: r.items };
}
function closeDoctor() {
  $('mask-doctor').classList.add('hidden');
  window.__pixelDoctor = { open: false };
}
if ($('wl-doctor')) $('wl-doctor').addEventListener('click', () => runDoctor());
if ($('set-doctor')) $('set-doctor').addEventListener('click', () => runDoctor());
if ($('doctor-ok')) $('doctor-ok').addEventListener('click', closeDoctor);
if ($('doctor-x')) $('doctor-x').addEventListener('click', closeDoctor);
if ($('mask-doctor')) $('mask-doctor').addEventListener('click', (e) => { if (e.target === $('mask-doctor')) closeDoctor(); });

// 老板 2026-10-13：「精装房，下载安装就可以用」—— 服务商预设：
// 选中就把接入地址填好，用户只剩「粘 Key → 拉模型 → 测存」。
// 选回「— 自己填地址 —」**不清空**已填的地址（用户可能刚手工改过，清了就得重打）。
if ($('wl-preset')) $('wl-preset').addEventListener('change', () => {
  const v = $('wl-preset').value;
  if (v) $('wl-base').value = v;
});

/* ============================================================
   启动
   ============================================================ */
syncCursor();
attachGirlClick();  // 吉祥物点击互动（冒气泡 + 点头）
setState('IDLE');   // 里面会 girlSay 冒第一句"打招呼"（3 秒后消失）
paintModelBar();
loadCfg();        // 先把设置读回来（主题色 / 紧凑 / 动画 / Enter 行为…），再画界面动作
renderTodos();
renderSubs();
renderBg();       // 老板 2026-10-13：右上角「智能体」栏的后台任务区（先画空态）
renderExts();
loadAgents();     // 启动就预读扩展清单（主进程串行排队，不会跟模型目录抢锁）
setTimeout(() => input.focus(), 120);
refreshSessions();
if (api) {
  api.info().then((i) => {
    if (i && i.cwd) { $('kv-cwd').textContent = i.cwd; $('kv-cwd').title = i.cwd; }
    if (i && i.firstRun) showWelcome();   // 打包分发：对方第一次用，先接模型
  });
  // 后台任务快照：主进程的起落点之后也会推 {kind:'bg'} 整表过来，
  // 这里补一次开局状态 —— 页面加载完之前就起来的任务不会漏。
  api.bgTasks().then((r) => {
    if (r && r.ok && Array.isArray(r.tasks)) { S.bg = r.tasks; renderBg(); }
  }).catch(() => {});
  // 启动后台悄悄查一次 GitHub Release：有新版本 → **像素冒泡说出来**（老板 2026-10-12：
  // "检查更新的提醒我希望是由像素那边说出来提醒"），状态栏徽章作为兜底。
  // 没网/超时/还没发过 Release 都静默（ok:false），绝不打扰使用。
  // ★ 老板 2026-10-12 23:5x：只有启动这一次不够（"启动提醒一次就没了"）——
  //   这条链路（查一次 → 冒泡 → 起周期）抽成 bootstrapUpdateCheck 了，
  //   好让验收喂假 api 把整张决策表验掉（见 verify-features 的 8c）。
  bootstrapUpdateCheck(api);
  api.files().then((r) => {
    if (r && r.items) { S.fileCache = r.items; S.fileDir = r.dir; }
  }).catch(() => {});
  // 启动就把模型目录拉下来：用量条要用上下文窗口当分母，
  // 视觉能力标记也要靠它判断（默认模型很可能看不懂图）。
  api.models().then((r) => {
    if (r && r.ok && r.models && r.models.length) {
      S.models = r.models;
      S.modelsLoaded = true;
      if (r.current) {
        S.curModel = r.current.model;
        S.curThinking = r.current.thinking;
        // pi 自己配置的默认模型：没手动切过时 current.model 是 null，
        // 靠它才能把用量条的分母填上（否则永远是 `— / —`）。
        S.piDefault = r.current.piDefault || null;
      }
      paintModelBar();
      const em = effModel();
      const ci = ctxInfoOf(em && em.provider, em && em.model);
      if (S.lastUsage) {
        setUsage(S.lastUsage, S.lastUsageModel);   // 目录刚到，补算分母
      } else if (ci.tokens) {
        $('ub-text').textContent = '— / ' + ctxLabel(ci);
        $('sb-usage').title = '上下文总窗口 ' + ci.tokens + ' tokens\n分母来源：' + ctxSourceZh(ci.source) + '\n（点一下看明细）';
      }
      updateVision();
      // （默认模型下拉已删：模型目录到了不用再重建下拉）
    }
  }).catch(() => {});
}

const q = new URLSearchParams(location.search);
if (q.get('auto')) {
  setTimeout(() => { input.value = q.get('auto'); syncCursor(); send(); }, 3000);
}
