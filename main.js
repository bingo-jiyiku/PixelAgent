// ============================================================
// main.js —— Electron 主进程
// 职责：开窗口 + 把渲染层的请求转给 pi-bridge，
//       再把 pi 吐出来的事件流转发回界面；
//       并提供「会话管理 / 历史回放 / 文件树 / 附件落盘 /
//       shell 执行 / 全局搜索 / 扩展清单」这些真数据。
// ============================================================
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell: electronShell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const bridge = require('./pi-bridge');
const { saveAttachments } = require('./attach');

let win = null;          // 主窗口
let job = null;          // 当前正在跑的 pi 子进程（支持"停止"）
let sessionSeq = 0;      // 当前会话序号（对应 .sessions/chat-<n>.json）

const APP_DIR = __dirname;

// 会话文件放在项目下的 .sessions/（在 E 盘，不占 C 盘）
const SESSION_DIR = path.join(APP_DIR, '.sessions');
// 用户发进来的图片落盘在这里（pi 只认文件路径，不认内存里的 base64）
const ATT_DIR = path.join(APP_DIR, '.attachments');
// pi 的**隔离**配置目录。
// 为什么不直接用 ~/.pi/agent：那边是老板终端里那套 pi 在用的。
// 两边共用一个目录会互相抢 settings.json.lock —— 而且 PixelAgent 一旦被强杀，
// 会留下 stale 锁把**终端里的 pi 一起弄坏**。隔离掉，各用各的。
const AGENT_DIR = path.join(APP_DIR, '.pi-agent');
// 自带扩展（给 pi 补一个 todo 工具，否则右栏 TODOS tab 永远是空的）
const TODO_EXT = path.join(APP_DIR, 'ext', 'todo.ts');
// 本应用的配置：工作目录 + 会话别名
const CONFIG_FILE = path.join(APP_DIR, '.pixelagent.json');

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// ---------- 配置 ----------
/*
  两张表要分清：
  · CFG_DEFAULTS —— **真设置**：改得动、存得下、能被验收读回。
  · names        —— 会话改名记录，不是"设置"，只是搭同一个文件存着。
  凡是界面上摆出来的开关，这里必须有对应字段 + 校验；反过来也成立，
  不摆"只显示不生效"的假设置（老板这轮的原话就是"设置要有设置该有的功能"）。
*/
const CFG_DEFAULTS = {
  workDir: APP_DIR,
  names: {},
  enterToSend: true,        // true=Enter 发送；false=Enter 换行、Ctrl+Enter 发送
  maxImages: 4,             // 一次最多几张图（1..9）
  accent: 'lav',            // 主题强调色
  mascotAnim: true,         // 吉祥物四态动画
  compact: false,           // 紧凑模式（行距更紧）
  autoScroll: true,         // 新消息自动滚到底
  exportFormat: 'html',     // 导出默认格式
  defaultModel: '',         // '' = 用 pi 默认
  defaultThinking: '',      // '' = 用 pi 默认
  // 单个模型的覆盖值：{ "provider/model": { contextTokens, maxOut } }。
  // 只影响**界面上的分母**（用量条），不改变 pi 实际能收多少上下文 ——
  // 存在的理由是 pi 对没声明 contextWindow 的模型会退回兜底值，
  // 用户看到的是那个兜底值却无从得知，也无从改。
  modelOverrides: {}
};
// 主题色：两档（主色 / 硬阴影色）成对给，改一个变量就能整体换皮
const ACCENTS = {
  lav:   { name: '发色粉',   main: '#f8b0c4', deep: '#d17590' }, // 老板 2026-10-11：默认粉色用吉祥物发色
  teal:  { name: '青瓷',     main: '#4f9c93', deep: '#3d7d76' },
  amber: { name: '琥珀',     main: '#c08a2e', deep: '#9a6c1f' },
  rose:  { name: '玫瑰',     main: '#c96a7e', deep: '#a04f61' }
};
const EXPORT_FORMATS = ['html', 'md', 'json'];

let cfg = { ...CFG_DEFAULTS };

// 白名单式校验：不在表里的键**一律丢掉**，免得界面笔误把垃圾写进配置文件
function normalizeCfg(patch) {
  const p = patch || {}, out = {};
  if ('enterToSend' in p) out.enterToSend = !!p.enterToSend;
  if ('maxImages' in p) {
    const n = Math.round(Number(p.maxImages));
    out.maxImages = (Number.isFinite(n) && n >= 1 && n <= 9) ? n : CFG_DEFAULTS.maxImages;
  }
  if ('accent' in p) out.accent = ACCENTS[p.accent] ? p.accent : CFG_DEFAULTS.accent;
  if ('mascotAnim' in p) out.mascotAnim = !!p.mascotAnim;
  if ('compact' in p) out.compact = !!p.compact;
  if ('autoScroll' in p) out.autoScroll = !!p.autoScroll;
  if ('exportFormat' in p) out.exportFormat = EXPORT_FORMATS.includes(p.exportFormat) ? p.exportFormat : CFG_DEFAULTS.exportFormat;
  if ('defaultModel' in p) out.defaultModel = typeof p.defaultModel === 'string' ? p.defaultModel : '';
  if ('defaultThinking' in p) {
    out.defaultThinking = THINKING_LEVELS.includes(p.defaultThinking) ? p.defaultThinking : '';
  }
  // 模型覆盖值：键和值都要过滤。整数、>0、有上限，
  // 免得界面把一个负数或 1e30 写进配置文件，用量条当场变成 0% 或永远 100%。
  if ('modelOverrides' in p) {
    const src = (p.modelOverrides && typeof p.modelOverrides === 'object') ? p.modelOverrides : {};
    const clean = {};
    for (const k of Object.keys(src).slice(0, 300)) {
      const v = src[k];
      if (!v || typeof v !== 'object') continue;
      const ent = {};
      const c = Math.round(Number(v.contextTokens));
      const x = Math.round(Number(v.maxOut));
      if (Number.isFinite(c) && c > 0) ent.contextTokens = Math.min(c, 100000000);
      if (Number.isFinite(x) && x > 0) ent.maxOut = Math.min(x, 100000000);
      if (Object.keys(ent).length) clean[String(k).slice(0, 160)] = ent;
    }
    out.modelOverrides = clean;
  }
  return out;
}

function loadCfg() {
  cfg = { ...CFG_DEFAULTS, names: {} };
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      if (typeof j.workDir === 'string' && j.workDir) cfg.workDir = j.workDir;
      if (j.names && typeof j.names === 'object') cfg.names = j.names;
      Object.assign(cfg, normalizeCfg(j));      // 老配置里没有的键自动落默认值
    }
  } catch (e) { /* 首次运行没有配置文件，用默认 */ }
  // 工作目录必须真实存在，否则文件树和 pi 的 cwd 都会出错
  try { if (!fs.statSync(cfg.workDir).isDirectory()) cfg.workDir = APP_DIR; }
  catch (e) { cfg.workDir = APP_DIR; }
}
function saveCfg() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { /* 写不进去不该崩 */ }
}
// 给界面看的子集：names 可能很大，不该跟着设置面板来回传
function cfgForUi() {
  const { names, ...rest } = cfg;
  return { ...rest, renameCount: Object.keys(names || {}).length };
}
// 写设置只有这一条路：白名单校验 → 落盘 → 回执。
// 抽成函数是因为「模型配置」也要走同一条路 —— 两处各写一份迟早会分叉。
function applyCfgPatch(patch) {
  const applied = normalizeCfg(patch);
  // 白名单外的键要**报出来**而不是默默吞掉：界面笔误（比如把 mascotAnim 写成 mascot）
  // 会表现成"点了保存但没生效"，没有这个回执就只能靠猜。
  const dropped = Object.keys(patch || {}).filter((k) => !(k in applied));
  Object.assign(cfg, applied);
  saveCfg();
  if ('defaultModel' in applied || 'defaultThinking' in applied) applyModelDefaults();
  return { ok: true, cfg: cfgForUi(), applied, droppedKeys: dropped };
}
loadCfg();

function sessionFile(seq) {
  const n = (seq == null) ? sessionSeq : seq;
  return path.join(SESSION_DIR, `chat-${n}.json`);
}

function send(obj) {
  if (win && !win.isDestroyed()) win.webContents.send('pi:msg', obj);
}

function getWindow() { return win; }

// ============================================================
// pi 配置目录准备：首次运行时把终端里那套凭据/模型目录抄一份过来
// （只抄凭据与模型定义，不抄 packages —— 见下面 ensureAgentDir 的说明）
// ============================================================
let agentDirState = { ready: false, copied: [], error: '' };

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

function ensureAgentDir() {
  const src = path.join(homeDir(), '.pi', 'agent');
  const copied = [];
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });

    // auth.json 是命根子：没有它 pi 会直接报 "No API key found"
    const want = ['auth.json', 'models.json', 'settings.json'];
    for (const f of want) {
      const dst = path.join(AGENT_DIR, f);
      const s = path.join(src, f);
      if (!fs.existsSync(dst) && fs.existsSync(s)) {
        fs.copyFileSync(s, dst);
        copied.push(f);
      }
    }

    // 顺手清掉本目录下自己的 stale 锁。
    // 只清 AGENT_DIR 里的 —— 这是 PixelAgent 自己的目录，清它不碰别人的东西。
    // （共享 ~/.pi/agent 时那种"被强杀留下锁、下次报 Lock file is already being held"
    //   的故障，隔离目录从结构上就不会波及终端里的 pi。）
    for (const lock of ['settings.json.lock', 'auth.json.lock', 'models-store.json.lock']) {
      const p = path.join(AGENT_DIR, lock);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory() && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      } catch (e) { /* 不存在就算了 */ }
    }

    const ok = fs.existsSync(path.join(AGENT_DIR, 'auth.json'));
    agentDirState = {
      ready: ok,
      copied,
      error: ok ? '' : (fs.existsSync(src)
        ? '没能从 ' + src + ' 取到 auth.json'
        : '在本机找不到 ' + src + ' —— 先在终端里跑一次 pi 并登录，或有 --api-key')
    };
  } catch (e) {
    agentDirState = { ready: false, copied, error: e.message };
  }
  return agentDirState;
}

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

// 数一下这条消息里带了几张图（不回传 base64：历史里塞大图会把 IPC 撑爆）
function imageCountOf(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((c) => c && c.type === 'image').length;
}

function parseSession(file) {
  const out = { exists: false, cwd: '', model: '', msgs: [], title: '', todos: [] };
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

      // 工具结果里带 todo 状态（自带扩展把状态放在 details 里）。
      // 只在历史里重建列表，不当成聊天消息显示。
      if (role === 'toolResult' && j.message.toolName === 'todo') {
        const det = j.message.details;
        if (det && Array.isArray(det.todos)) {
          out.todos = det.todos.map((t) => ({
            id: t.id,
            text: String(t.text == null ? '' : t.text),
            done: !!t.done
          }));
        }
        continue;
      }

      const t = textOf(j.message.content);
      const imgs = imageCountOf(j.message.content);
      if (!t && !imgs) continue;
      if (role === 'user') out.msgs.push({ role: 'user', text: t, images: imgs });
      else if (role === 'assistant') out.msgs.push({ role: 'assistant', text: t, images: 0 });
    }
  }
  const firstUser = out.msgs.find((m) => m.role === 'user');
  out.title = firstUser
    ? (firstUser.text.replace(/\s+/g, ' ').slice(0, 42) ||
       (firstUser.images ? '[图片 ×' + firstUser.images + ']' : ''))
    : '(空会话)';
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
    const alias = cfg.names[String(seq)];
    return {
      seq,
      file,
      mtime: st ? st.mtimeMs : 0,
      size: st ? st.size : 0,
      title: alias || parsed.title,     // 用户改过名就用用户的
      renamed: !!alias,
      rounds,
      current: seq === sessionSeq
    };
  });
  rows.sort((a, b) => b.mtime - a.mtime);   // 最近改动的排前面
  return rows;
}

// ============================================================
// 文件树（只列一层，可点进子目录；限制在工作目录之下）
// ============================================================
function listFiles(dir) {
  const base = path.resolve(cfg.workDir);
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
// 附件落盘
// 实现抽到了 attach.js（纯 Node，能直接单测路径安全），这里直接用。
// ============================================================

// ============================================================
// 模型目录 + 当前模型 / 思考档位
// 数据来源是真跑 `pi --list-models`（132 个模型，带 context 窗口和 images 能力），
// 不是写死的表。images 那一列很重要：喂图前要靠它判断模型看不看得懂图。
// ============================================================
let modelsCache = null;   // 模型列表缓存（一次会话内不变）
let curModel = null;      // null = 用 pi 自己的默认配置
let curThinking = null;   // null = 用 pi 默认；否则 off|minimal|low|medium|high|xhigh|max

// 设置里的"默认模型 / 默认思考档位" → 当前选择。
// 只在两处调用：① 启动时；② 用户真的改了这两个设置时。
// 故意**不**在每次保存设置时调用 —— 否则"换主题色"会把用户刚选的模型重置掉。
function applyModelDefaults() {
  const m = String(cfg.defaultModel || '');
  const i = m.indexOf('/');
  curModel = (i > 0) ? { provider: m.slice(0, i), model: m.slice(i + 1) } : null;
  curThinking = THINKING_LEVELS.includes(cfg.defaultThinking) ? cfg.defaultThinking : null;
}
applyModelDefaults();

// 「128K」到底是多少？**必须跟 pi 自己一个算法**。
// pi 的 dist/cli/list-models.js 里 `formatTokenCount` 是 ÷1000（1_000 → "1K"，
// 1_000_000 → "1M"），所以 pi 说的 `128K` 就是 128000，不是 131072。
// 我一开始按 1024 算，于是同一个模型在界面上出现两个数：
// pi 表写 `128K`，我们把它翻成 `131072 词元` —— 这正是"这数哪来的"的诱因之一。
function parseSize(s) {
  const m = /^([\d.]+)\s*([KM]?)$/.exec(String(s || ''));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Math.round(n * (m[2] === 'M' ? 1000000 : m[2] === 'K' ? 1000 : 1));
}

// 解析 `pi --list-models` 的表格：provider / model / context / max-out / thinking / images
function parseModels(text) {
  const rows = [];
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  for (let i = 1; i < lines.length; i++) {   // 第 0 行是表头
    const m = /^(\S+)\s+(\S+)\s+([\d.]+[KM]?)\s+([\d.]+[KM]?)\s+(yes|no)\s+(yes|no)/.exec(lines[i]);
    if (!m) continue;
    rows.push({
      provider: m[1], model: m[2],
      context: m[3], maxOut: m[4],
      contextTokens: parseSize(m[3]),
      thinking: m[5] === 'yes',
      images: m[6] === 'yes'
    });
  }
  return rows;
}

// 跑一次 pi 的纯查询命令（不是 agent 调用），拿 stdout。
// 函数名带 Once 是有意的：外面还套了一层「串行 + 重试」的 runPiQuery。
function runPiQueryOnce(args, timeoutMs, agentDir) {
  return new Promise((resolve) => {
    const { node, cli } = bridge.locate();
    if (!cli) { resolve({ ok: false, error: '找不到 pi 入口' }); return; }
    const env = Object.assign({}, process.env, { PI_OFFLINE: process.env.PI_OFFLINE || '' });
    if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
    let child;
    try {
      child = spawn(node, [cli, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],   // stdin 必须断开，否则 pi 会挂住
        windowsHide: true,
        env
      });
    } catch (e) { resolve({ ok: false, error: e.message }); return; }

    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve({ ok: false, error: '查询超时' });
    }, timeoutMs || 30000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', () => { clearTimeout(timer); resolve({ ok: true, out, err }); });
  });
}

// ---------- 串行 + 重试的查询包装 ----------
// 为什么要串行：pi 启动时要抢配置目录里的 settings.json.lock。
// 两个 pi 进程同时启动会互相抢不到；抢不到 pi 就直接判定"配置无效"，
// 表现是莫名其妙的 "Lock file is already being held" + "No API key found"
// （开发过程中真的这么中过一次，排查花了很久）。
// 所以两件事一起做：① 同一时刻只跑一个查询；② 撞上了就退避重试。
let piQueryChain = Promise.resolve();

async function runPiQuery(args, timeoutMs, agentDir) {
  const task = async () => {
    // 有对话在跑就先让开，别跟它抢锁（最多等 20 秒）
    for (let i = 0; i < 100 && job; i++) await new Promise((r) => setTimeout(r, 200));
    let r = { ok: false, error: 'unknown' };
    for (let i = 0; i < 3; i++) {
      r = await runPiQueryOnce(args, timeoutMs, agentDir);
      const blob = String(r.out || '') + String(r.err || '');
      if (!/Lock file is already being held|state lock timeout/.test(blob)) return r;
      await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    }
    return r;
  };
  const next = piQueryChain.then(task, task);
  piQueryChain = next.then(() => {}, () => {});   // 链条不能因为一次失败就断
  return next;
}

function modelState() { return { model: curModel, thinking: curThinking, piDefault: piDefaultModel() }; }

/* ============================================================
   单个模型的「配置 / 测试」
   ------------------------------------------------------------
   起因：老板问"上下文怎么只有十万，是你定的还是模型定的"。
   查下来是**第三种情况**：pi 的模型表里有些模型根本没声明 contextWindow
   （实测 agent-plan/provider 下的 ark-code-latest 在 models.json 里
   只有一个 {"id":"..."}），pi 只能退到自己的兜底常量 128e3。
   所以那个数字既不是模型说的、也不是我们定的 —— 是 pi 的补位值。
   用户既看不到这层，也没法改。这里把三件事补上：
     ① `pi:model-info`  把"这个数字从哪来"摊开（声明值 / 报的值 / 我们的覆盖）；
     ② `pi:model-set-config` 允许覆盖（**只影响界面上的分母**，不改 pi 的接收能力）；
     ③ `pi:model-test` 真发一次最小请求，验证这个模型到底通不通。
   ------------------------------------------------------------
   注意：models.json 里有 apiKey，**绝不能**整份回给渲染层。
   下面只回 baseUrl 和"有没有 key"，连掩码都不回。
   ============================================================ */
function readPiJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(AGENT_DIR, name), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function piDefaultModel() {
  const s = readPiJson('settings.json');
  if (!s.defaultModel) return null;
  return { provider: s.defaultProvider || null, model: String(s.defaultModel) };
}
function modelKey(p, m) { return String(p || '') + '/' + String(m || ''); }
function overrideOf(p, m) {
  const map = (cfg.modelOverrides && typeof cfg.modelOverrides === 'object') ? cfg.modelOverrides : {};
  const o = map[modelKey(p, m)];
  return (o && typeof o === 'object') ? o : null;
}

ipcMain.handle('pi:model-info', (_e, sel) => {
  const p = String((sel && sel.provider) || '');
  const m = String((sel && sel.model) || '');
  if (!m) return { ok: false, error: '没有指定模型' };

  const provs = readPiJson('models.json').providers || {};
  const prov = provs[p] || null;
  const declared = (prov && Array.isArray(prov.models))
    ? (prov.models.find((x) => x && x.id === m) || null)
    : null;

  const hit = (modelsCache || []).find((x) => x.model === m && (!p || x.provider === p)) || null;

  return {
    ok: true,
    provider: p, model: m,
    baseUrl: prov ? (prov.baseUrl || '') : '',
    api: prov ? (prov.api || '') : '',
    // 只说有没有，不回内容
    hasKey: !!(prov && prov.apiKey),
    // ① 模型自己在 models.json 里声明的（最权威，但经常没有）
    declared: declared ? {
      contextWindow: declared.contextWindow || 0,
      maxTokens: declared.maxTokens || 0,
      input: Array.isArray(declared.input) ? declared.input : []
    } : null,
    // ② pi --list-models 报出来的（带兜底，所以可能不是模型的原话）
    reported: hit ? { context: hit.context, maxOut: hit.maxOut, contextTokens: hit.contextTokens,
                      maxOutTokens: hit.maxOutTokens, thinking: hit.thinking, images: hit.images } : null,
    // ③ 我们自己的覆盖
    override: overrideOf(p, m),
    isDefault: (() => {
      const d = piDefaultModel();
      return !!(d && d.model === m && (!d.provider || d.provider === p));
    })()
  };
});

ipcMain.handle('pi:model-set-config', (_e, sel) => {
  const p = String((sel && sel.provider) || '');
  const m = String((sel && sel.model) || '');
  if (!m) return { ok: false, error: '没有指定模型' };
  const map = Object.assign({}, cfg.modelOverrides || {});
  const k = modelKey(p, m);
  if (sel && sel.clear) delete map[k];
  else map[k] = Object.assign({}, map[k], {
    contextTokens: Number(sel.contextTokens) || 0,
    maxOut: Number(sel.maxOut) || 0
  });
  // ★★ 这里必须**包一层** `{ modelOverrides: map }`。
  //   applyCfgPatch 收的是**配置补丁**（顶层键：enterToSend / modelOverrides / …），
  //   直接把这整张"provider/model → 值"的表当补丁传进去，白名单里一个顶层键都找不到，
  //   于是 `Object.assign(cfg, applied)` 等于什么都没写，而且 droppedKeys 还会被算成
  //   `['agent-plan/ark-code-latest']` —— 报错文案看着像"键名写错了"，实际是**层级错了**。
  //   现象：模型行点「配置」→ 填值 → 保存，不报任何错、还提示了一句，
  //   但覆盖值永远不落盘（`modelOverrides` 一直是 `{}`）。上一轮这个功能是坏的。
  const r = applyCfgPatch({ modelOverrides: map });
  return { ok: !!(r && r.ok), applied: r && r.applied, droppedKeys: r && r.droppedKeys, cfg: r && r.cfg };
});

// 老板 2026-10-11：模型菜单要有"新增自定义模型"入口。
// 直接把记录插进 .pi-agent/models.json，pi 下次 --list-models 就会看到它。
// 结构参考现有 models.json：
//   providers.<name>.{api, apiKey, baseUrl, models:[{id, contextWindow, maxTokens, input}]}
// 规则：
//   - provider 已存在：往 models 数组里追加，baseUrl/apiKey 只在**新填**时才覆盖
//     （填了空值就不要把已有配置擦掉）
//   - provider 不存在：新建整个对象，api 默认 openai-completions（pi 最常用的协议）
//   - modelId 已存在：**拒收**（避免静默覆盖）
//   - 写完把 modelsCache 置空 —— 否则 pi:models 会返回旧缓存，界面看不到新模型
ipcMain.handle('pi:add-model', (_e, p) => {
  const provider = String((p && p.provider) || '').trim();
  const modelId = String((p && p.modelId) || '').trim();
  const baseUrl = String((p && p.baseUrl) || '').trim();
  const apiKey = String((p && p.apiKey) || '').trim();
  const ctx = Number(p && p.contextWindow) || 0;
  const max = Number(p && p.maxTokens) || 0;
  if (!provider) return { ok: false, error: '服务商不能为空' };
  if (!modelId) return { ok: false, error: '模型 ID 不能为空' };
  if (ctx && (ctx <= 0 || !Number.isFinite(ctx))) return { ok: false, error: '上下文窗口要填正整数' };
  if (max && (max <= 0 || !Number.isFinite(max))) return { ok: false, error: '最大输出要填正整数' };

  const mf = path.join(AGENT_DIR, 'models.json');
  const doc = readPiJson('models.json');
  const provs = (doc.providers && typeof doc.providers === 'object') ? doc.providers : {};

  if (!provs[provider]) {
    // 新建 provider：api 默认 openai-completions（pi 里最通用的协议）
    provs[provider] = { api: 'openai-completions', models: [] };
    if (baseUrl) provs[provider].baseUrl = baseUrl;
    if (apiKey) provs[provider].apiKey = apiKey;
  } else {
    if (!Array.isArray(provs[provider].models)) provs[provider].models = [];
    // 只覆盖用户**填了**的字段 —— 空字符串不要动已有配置
    if (baseUrl) provs[provider].baseUrl = baseUrl;
    if (apiKey) provs[provider].apiKey = apiKey;
  }
  const prov = provs[provider];
  // 重复检测：同名模型已在同 provider 里 ⇒ 拒收
  if (prov.models.find((m) => m && m.id === modelId)) {
    return { ok: false, error: '这个模型已经存在于 ' + provider + ' 下，换一个 ID 或者先去配置它' };
  }

  const m = { id: modelId };
  if (ctx) m.contextWindow = ctx;
  if (max) m.maxTokens = max;
  // input 保留可选：不填就走 pi 默认（一般是 text）
  if (Array.isArray(p && p.input) && p.input.length) m.input = p.input;
  prov.models.push(m);

  doc.providers = provs;
  try {
    fs.writeFileSync(mf, JSON.stringify(doc, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: '写 models.json 失败: ' + e.message };
  }
  // 强制下次 pi:models 重跑 —— 否则缓存还在，界面看不到刚加的
  modelsCache = null;
  return { ok: true, provider, modelId };
});

// ============================================================
// 老板 2026-10-11 17:44：「新增模型那一块需要链接测试那些功能」
// 「模型 ID 在配置好获取模型就会自动读取它里面所有可用的模型」
// 「上下文窗口和读写输出那些配置模型的时候要自动读取它原本的」
//
// 两个 IPC，都直接打 OpenAI-compatible REST（不走 pi CLI，避免把用户还没落盘的
// 半填表单硬写进 .pi-agent/models.json 才做试连）：
//   - pi:fetch-provider-models  GET  {base}/v1/models           拿这个 base/key 下所有模型 ID
//   - pi:test-connection        POST {base}/v1/chat/completions 发一次 max_tokens=1 的最小请求
//
// 两条都用 Node 18+ 内置的 global fetch（Electron 20+ 已支持，不用引依赖）。
// ============================================================
// 把用户填的 base URL 规范化成「{base}/v1」，能同时接住下面几种写法：
//   https://api.openai.com                      → https://api.openai.com/v1
//   https://api.openai.com/                     → https://api.openai.com/v1
//   https://api.openai.com/v1                   → https://api.openai.com/v1（已带 /v1，不重复加）
//   https://api.openai.com/v1/                  → https://api.openai.com/v1
//   https://api.openai.com/chat/completions     → https://api.openai.com（把 /chat/completions 剥掉）
function normalizeOpenAIBase(baseUrl) {
  let s = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  // 用户不小心填成 .../chat/completions 或 .../completions 的，剥到最后一段
  s = s.replace(/\/chat\/completions$/, '').replace(/\/completions$/, '');
  if (/\/v\d+$/.test(s)) return s;          // 已经带 /v1 /v2 之类，直接用
  return s + '/v1';                          // 没带版本号，补一个默认的 /v1
}

ipcMain.handle('pi:fetch-provider-models', async (_e, p) => {
  const baseUrl = normalizeOpenAIBase((p && p.baseUrl) || '');
  const apiKey = String((p && p.apiKey) || '').trim();
  if (!baseUrl) return { ok: false, error: '接入地址不能为空' };
  if (!apiKey) return { ok: false, error: 'API Key 不能为空' };
  const url = baseUrl + '/models';
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    return { ok: false, error: '请求失败：' + (e && e.message || e) };
  }
  if (!resp.ok) {
    let body = '';
    try { body = (await resp.text()).slice(0, 300); } catch (e2) { /* ignore */ }
    return { ok: false, status: resp.status, error: 'HTTP ' + resp.status + (body ? '：' + body : '') };
  }
  let data;
  try { data = await resp.json(); } catch (e) {
    return { ok: false, error: '响应不是 JSON：' + (e && e.message || e) };
  }
  const raw = Array.isArray(data && data.data) ? data.data : (Array.isArray(data) ? data : []);
  const models = raw.map((m) => ({
    id: String((m && (m.id || m.name || m.model)) || '').trim(),
    created: Number((m && m.created)) || 0,
    object: String((m && m.object) || '')
  })).filter((m) => m.id);
  return { ok: true, count: models.length, models };
});

ipcMain.handle('pi:test-connection', async (_e, p) => {
  const baseUrl = normalizeOpenAIBase((p && p.baseUrl) || '');
  const apiKey = String((p && p.apiKey) || '').trim();
  const modelId = String((p && p.modelId) || '').trim();
  if (!baseUrl) return { ok: false, error: '接入地址不能为空' };
  if (!apiKey) return { ok: false, error: 'API Key 不能为空' };
  if (!modelId) return { ok: false, error: '模型 ID 不能为空' };
  const url = baseUrl + '/chat/completions';
  const payload = {
    model: modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false
  };
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: '请求失败：' + (e && e.message || e) };
  }
  const ms = Date.now() - t0;
  if (!resp.ok) {
    let body = '';
    try { body = (await resp.text()).slice(0, 400); } catch (e2) { /* ignore */ }
    return { ok: false, ms, status: resp.status, error: 'HTTP ' + resp.status + (body ? '：' + body : '') };
  }
  let data;
  try { data = await resp.json(); } catch (e) {
    return { ok: false, ms, error: '响应不是 JSON：' + (e && e.message || e) };
  }
  const choice = data && Array.isArray(data.choices) && data.choices[0];
  const text = String((choice && choice.message && choice.message.content) || '').slice(0, 200);
  const usage = (data && data.usage) || null;
  return {
    ok: true,
    ms,
    text: text || '(空回复，但请求成功了)',
    model: String((data && data.model) || modelId),
    finishReason: String((choice && choice.finish_reason) || ''),
    inputTokens: (usage && (usage.prompt_tokens || usage.input)) || 0,
    outputTokens: (usage && (usage.completion_tokens || usage.output)) || 0,
    totalTokens: (usage && (usage.total_tokens || usage.totalTokens)) || 0
  };
});

ipcMain.handle('pi:model-test', async (_e, sel) => {
  const p = String((sel && sel.provider) || '');
  const m = String((sel && sel.model) || '');
  if (!m) return { ok: false, error: '没有指定模型' };
  const t0 = Date.now();
  const r = await runPiQuery([
    '-p', '--mode', 'json', '--no-session', '-nt',
    '--provider', p, '--model', m,
    '只回复 OK 两个字母，不要解释，不要调用任何工具'
  ], 90000, AGENT_DIR);
  const ms = Date.now() - t0;
  const out = String(r.out || '');
  const err = String(r.err || '');

  // 从真事件流里挑证据：最后一条 assistant 文本 + usage + durationMs + responseModel
  let text = '', usage = null, durationMs = 0, responseModel = '', stopReason = '';
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch (e2) { continue; }
    const msg = ev && (ev.message || (ev.assistantMessageEvent && ev.assistantMessageEvent.message));
    if (ev && ev.type === 'message_update' && ev.assistantMessageEvent &&
        ev.assistantMessageEvent.type === 'text_delta') text += ev.assistantMessageEvent.delta || '';
    if (msg && msg.role === 'assistant') {
      if (msg.usage) usage = msg.usage;
      if (msg.durationMs) durationMs = msg.durationMs;
      if (msg.responseModel) responseModel = msg.responseModel;
      if (msg.stopReason) stopReason = msg.stopReason;
      if (Array.isArray(msg.content)) {
        const t = msg.content.find((c) => c && c.type === 'text');
        if (t && t.text) text = t.text;
      }
    }
  }
  if (!text && err) {
    // 失败时别把整个 stderr 甩上去：挑最像原因的那一行
    const line = err.split('\n').filter((x) => /error|Error|API key|not found|Unknown|denied|401|403|404/.test(x))[0]
      || err.split('\n').filter((x) => x.trim())[0] || '';
    return { ok: false, ms, totalMs: ms, error: line.trim().slice(0, 400), raw: err.slice(-600) };
  }
  return {
    ok: !!text, ms, totalMs: ms, durationMs,
    text: text.slice(0, 200),
    responseModel: responseModel || '',
    stopReason: stopReason || '',
    totalTokens: (usage && usage.totalTokens) || 0,
    inputTokens: (usage && usage.input) || 0,
    outputTokens: (usage && usage.output) || 0
  };
});

// 发问前把配置目录上的查询排空。
// ------------------------------------------------------------
// runPiQuery 的队列只做了单向等待：查询会等对话（`if (job)`），
// 但**对话不等查询**。于是实测到过这个场景：启动时的 --list-models
// 还在跑，用户立刻发问 ⇒ 两个 pi 同时动 .pi-agent 下的 settings.json.lock
// ⇒ pi 报 "Invalid settings file ... settings.json.lock" 并降级。
// 这条警告会以 stderr 的形式出现在界面顶部，看着像出大事了。
// 补上反向等待，让两边不再撞。
async function drainPiQueries() {
  try { await piQueryChain; } catch (e) { /* 链条自己吞了失败，这里只是等它落地 */ }
}

// 发问时要拼的参数（扩展 / 模型 / 思考档位）
function modelArgs() {
  const a = [];
  // 自带 todo 扩展：pi 本体没有 todo 工具，不挂这个右栏 TODOS 就是死的
  if (fs.existsSync(TODO_EXT)) a.push('--extension', TODO_EXT);
  if (curModel && curModel.provider && curModel.model) {
    a.push('--provider', curModel.provider, '--model', curModel.model);
  }
  if (curThinking) a.push('--thinking', curThinking);
  return a;
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
ipcMain.handle('pi:ask', async (_e, payload) => {
  if (job) return { ok: false, reason: 'BUSY' };

  // 兼容两种调用：老式直接给字符串，新式给 {text, images}
  const text = typeof payload === 'string' ? payload : String((payload && payload.text) || '');
  const images = (payload && Array.isArray(payload.images)) ? payload.images : [];

  // saveAttachments 现在返回 {saved, rejected}。
  // rejected 必须一路带回界面 —— 图片收不下的原因（格式坏 / 超限 / 文件名不合法）
  // 只有我们知道，pi 那边只会含糊地说一句 "could not be resized"。
  const att = saveAttachments(images, ATT_DIR);
  const files = att.saved.map((f) => f.path);

  if (!text && !files.length) {
    // 图全被拒了又没打字：别装没事把空请求发出去
    if (att.rejected.length) {
      return { ok: false, reason: 'IMAGE_REJECTED', rejected: att.rejected };
    }
    return { ok: false, reason: 'EMPTY' };
  }

  const loc = bridge.locate();
  send({ kind: 'boot', node: loc.node, cli: loc.cli, session: sessionFile() });

  // 先把还在跑的查询（--list-models / pi list …）等干净，再起对话 —— 见 drainPiQueries 的说明
  await drainPiQueries();

  job = bridge.ask({
    prompt: text || '（看这张图）',
    attachments: files,
    sessionFile: sessionFile(),
    cwd: cfg.workDir,
    agentDir: AGENT_DIR,
    extraArgs: modelArgs(),          // 扩展 / 模型 / 思考档位
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

  return { ok: true, attachments: files.length, rejected: att.rejected };
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
  return { ok: true, seq: n, cwd: parsed.cwd, model: parsed.model, msgs: parsed.msgs, todos: parsed.todos };
});

// ---------- 会话重命名（只记别名，不动 pi 的会话文件） ----------
// ---------- 会话重命名（只记别名，不动 pi 的会话文件） ----------
// 校验放在主进程：只有它手里有"全部会话的最终标题"（别名 || 自动标题），
// 界面那边只有一份渲染结果，拿它去判重是会判漏的。
ipcMain.handle('pi:session-rename', (_e, seq, name) => {
  const n = Number(seq);
  if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'BAD_SEQ' };

  // 控制字符会把列表布局搞乱（换行/制表），先清掉再压空格
  const clean = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  if (clean) {
    const rows = listSessions();
    const clash = rows.filter((s) => s.seq !== n && s.title === clean)[0];
    if (clash) {
      return { ok: false, reason: 'NAME_TAKEN', clash: clash.seq, name: clean, sessions: rows };
    }
  }

  if (clean) cfg.names[String(n)] = clean;
  else delete cfg.names[String(n)];      // 传空 = 恢复成自动标题
  saveCfg();
  return { ok: true, seq: n, name: clean, cleared: !clean, sessions: listSessions() };
});

// ---------- 会话删除：进回收站，绝不 rm ----------
ipcMain.handle('pi:session-delete', async (_e, seq) => {
  const n = Number(seq);
  if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'BAD_SEQ' };
  const file = sessionFile(n);
  if (!fs.existsSync(file)) return { ok: false, reason: 'NOT_FOUND' };

  let trashErr = '';
  try {
    await electronShell.trashItem(file);   // 可恢复，比删掉安全得多
  } catch (e) {
    trashErr = (e && e.message) || String(e);
  }

  // ★ 不能只看 trashItem 有没有 reject。
  //   本机实测（test/_trash-probe.js）：它会把文件**移走之后仍然 reject**
  //   "Operation was aborted"。只按异常判，界面就会弹"删除失败"，
  //   而文件其实已经离开原位置了 —— 用户看了假警报还得自己去找文件。
  //   所以以**文件还在不在**为事实依据，异常只作为补充说明带回去。
  if (fs.existsSync(file)) {
    return { ok: false, reason: 'TRASH_FAILED', error: trashErr || '文件仍然存在' };
  }

  delete cfg.names[String(n)];
  saveCfg();
  const wasCurrent = (n === sessionSeq);
  if (wasCurrent) {
    if (job) { job.abort(); job = null; }
    const seqs = listSessionSeqs();
    sessionSeq = seqs.length ? Math.max(...seqs) : 0;
  }
  // trashNote 非空 = 回收站那一步报了异常，但文件确实已移出。
  // 界面据此说清楚「可恢复性没确认」，而不是假装一切正常。
  return {
    ok: true, removedCurrent: wasCurrent, trashNote: trashErr,
    sessions: listSessions(), current: sessionSeq
  };
});

// ---------- 会话导出：三种格式，默认哪种由设置决定 ----------
// 支持两种走法：
//   exportSession(seq)              → 弹系统保存框（界面按钮用）
//   exportSession(seq, outPath)     → 直接写到指定路径，不开框（验收 / 脚本 / 命令面板用）
// 为什么要拆出 outPath：系统保存框是阻塞式的，自动化验收没法点它，
// 于是"导出"这个功能就一直验不了。能绕开对话框的接口，才验得动。
//
// 为什么自己写 md / json 两条路：设置里那个「导出格式」如果只改后缀名、
// 内容还是一份 HTML，那就是**假设置**。要么不摆这个开关，要么三种都是真的。
function sessionToMarkdown(parsed, title) {
  const L = [];
  L.push('# ' + (title || 'PixelAgent 会话'));
  L.push('');
  L.push('- 导出时间：' + new Date().toLocaleString('zh-CN'));
  if (parsed.model) L.push('- 模型：' + parsed.model);
  if (parsed.cwd) L.push('- 工作目录：' + parsed.cwd);
  L.push('');
  for (const m of parsed.msgs) {
    L.push('## ' + (m.role === 'user' ? '你' : '助手'));
    L.push('');
    if (m.images) L.push('> （含 ' + m.images + ' 张图片，Markdown 里不保留）\n');
    L.push(String(m.text || '').trim());
    L.push('');
  }
  if (parsed.todos && parsed.todos.length) {
    L.push('## 待办');
    L.push('');
    for (const t of parsed.todos) L.push('- [' + (t.done ? 'x' : ' ') + '] ' + t.text);
    L.push('');
  }
  return L.join('\n');
}

ipcMain.handle('pi:session-export', async (_e, seq, outPath, fmtArg) => {
  const n = Number(seq == null ? sessionSeq : seq);
  const file = sessionFile(n);
  if (!fs.existsSync(file)) return { ok: false, reason: 'NOT_FOUND' };

  const alias = cfg.names[String(n)];
  const fmt = EXPORT_FORMATS.includes(fmtArg) ? fmtArg : cfg.exportFormat;
  const ext = fmt === 'md' ? 'md' : fmt === 'json' ? 'json' : 'html';
  const FMT_NAME = { html: '独立 HTML', md: 'Markdown 文档', json: '原始 JSON' };
  let target = typeof outPath === 'string' && outPath ? outPath : '';

  if (!target) {
    if (!win || win.isDestroyed()) return { ok: false, reason: 'NO_WINDOW' };
    const r = await dialog.showSaveDialog(win, {
      title: '导出会话（' + FMT_NAME[fmt] + '）',
      defaultPath: path.join(cfg.workDir, (alias || ('pixelagent-chat-' + n)) + '.' + ext),
      filters: [{ name: FMT_NAME[fmt], extensions: [ext] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'CANCELED' };
    target = r.filePath;
  }

  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) { /* 目录已存在即可 */ }

  // JSON：原样搬走 pi 的会话文件（无损，便于二次处理）
  if (fmt === 'json') {
    try { fs.copyFileSync(file, target); return { ok: true, out: target, format: fmt }; }
    catch (e) { return { ok: false, reason: 'EXPORT_FAILED', error: e.message }; }
  }

  // Markdown：自己按消息渲染（pi 的 --export 只出 HTML，没有 md）
  if (fmt === 'md') {
    try {
      const parsed = parseSession(file);
      fs.writeFileSync(target, sessionToMarkdown(parsed, alias || parsed.title), 'utf8');
      return { ok: true, out: target, format: fmt };
    } catch (e) { return { ok: false, reason: 'EXPORT_FAILED', error: e.message }; }
  }

  // HTML：交给 pi 自己的 --export
  const q = await runPiQuery(['--export', file, target], 60000, AGENT_DIR);
  if (q.ok && fs.existsSync(target)) return { ok: true, out: target, format: fmt };
  return { ok: false, reason: 'EXPORT_FAILED', error: q.error || (q.err || '').slice(-400) };
});

// ---------- 跨会话全局搜索 ----------
// 线性扫 .sessions 下所有会话文件。会话多了会慢，所以：
// 超大文件跳过、每个会话最多贡献 2 条命中、总数封顶 60。
ipcMain.handle('pi:search', (_e, q) => {
  const key = String(q == null ? '' : q).trim().toLowerCase();
  if (key.length < 2) return { ok: true, hits: [], need: 2 };
  const MAX_FILE = 32 * 1024 * 1024;
  const hits = [];

  for (const seq of listSessionSeqs()) {
    if (hits.length >= 60) break;
    const file = sessionFile(seq);
    let st = null;
    try { st = fs.statSync(file); } catch (e) { continue; }
    if (st.size > MAX_FILE) continue;

    const parsed = parseSession(file);
    const alias = cfg.names[String(seq)];
    let got = 0;
    for (let i = 0; i < parsed.msgs.length && got < 2; i++) {
      const m = parsed.msgs[i];
      const at = m.text.toLowerCase().indexOf(key);
      if (at < 0) continue;
      const from = Math.max(0, at - 34);
      hits.push({
        seq,
        title: alias || parsed.title,
        role: m.role,
        idx: i,
        snippet: (from > 0 ? '…' : '') + m.text.slice(from, at + key.length + 46).replace(/\s+/g, ' ')
      });
      got++;
    }
  }
  return { ok: true, hits };
});

// ---------- 文件树 ----------
ipcMain.handle('pi:files', (_e, dir) => listFiles(dir));

// ---------- 选择工作目录（同时成为 pi 的 cwd，@ 引用也按它解析） ----------
function setWorkDir(dir) {
  const abs = path.resolve(String(dir || ''));
  let st = null;
  try { st = fs.statSync(abs); } catch (e) {
    return { ok: false, reason: 'NOT_FOUND', error: e.message };
  }
  if (!st.isDirectory()) return { ok: false, reason: 'NOT_DIR' };
  cfg.workDir = abs;
  saveCfg();
  return { ok: true, dir: abs, files: listFiles(abs) };
}

ipcMain.handle('pi:set-workdir', (_e, dir) => setWorkDir(dir));

ipcMain.handle('pi:pick-dir', async () => {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'NO_WINDOW' };
  const r = await dialog.showOpenDialog(win, {
    title: '选择工作目录',
    defaultPath: cfg.workDir,
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, reason: 'CANCELED' };
  return setWorkDir(r.filePaths[0]);
});

// ---------- `!` 直接执行 shell（不经过 pi） ----------
// 语义上跟模型无关：这是"我在自己机器上敲一条命令"，所以不该花 token，
// 也不该让模型替用户决定跑不跑。
const shellJobs = {};

function findShell() {
  if (process.platform !== 'win32') return { exe: process.env.SHELL || '/bin/bash', args: ['-lc'] };
  const cands = [
    process.env.PIXELAGENT_SHELL,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return { exe: c, args: ['-lc'] }; } catch (e) { /* ignore */ } }
  return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] };
}

ipcMain.handle('pi:run-shell', (_e, payload) => {
  const cmd = String((payload && payload.cmd) || '');
  const id = String((payload && payload.id) || Date.now());
  if (!cmd.trim()) return { ok: false, reason: 'EMPTY' };
  if (shellJobs[id]) return { ok: false, reason: 'BUSY' };

  const sh = findShell();
  let child;
  try {
    child = spawn(sh.exe, [...sh.args, cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: cfg.workDir,
      env: process.env
    });
  } catch (e) {
    return { ok: false, reason: 'SPAWN_FAILED', error: e.message };
  }
  shellJobs[id] = child;

  const pump = (stream) => (chunk) => send({ kind: 'shell', id, stream, data: String(chunk) });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', pump('out'));
  child.stderr.on('data', pump('err'));
  child.on('error', (e) => {
    delete shellJobs[id];
    send({ kind: 'shell', id, stream: 'err', data: String(e.message) + '\n' });
    send({ kind: 'shell', id, done: true, code: -1 });
  });
  child.on('close', (code) => {
    delete shellJobs[id];
    send({ kind: 'shell', id, done: true, code });
  });

  return { ok: true, id, shell: sh.exe, cwd: cfg.workDir };
});

ipcMain.handle('pi:shell-kill', (_e, id) => {
  const c = shellJobs[String(id)];
  if (!c) return { ok: false };
  try { c.kill(); } catch (e) { /* ignore */ }
  delete shellJobs[String(id)];
  return { ok: true };
});

// ---------- 模型目录（真跑 pi --list-models） ----------
// 并发去重：启动时和打开面板时可能同时要，别重复跑两次子进程
let modelsPromise = null;

ipcMain.handle('pi:models', async () => {
  if (modelsCache) return { ok: true, models: modelsCache, current: modelState() };
  if (!modelsPromise) {
    modelsPromise = runPiQuery(['--list-models'], 60000, AGENT_DIR).then((r) => {
      modelsPromise = null;
      if (!r.ok) return { ok: false, error: r.error, models: [], current: modelState() };
      modelsCache = parseModels(r.out);
      return { ok: true, models: modelsCache, current: modelState() };
    });
  }
  return modelsPromise;
});

// ---------- 切换模型（provider/model 都为空 = 回到 pi 默认） ----------
ipcMain.handle('pi:set-model', (_e, sel) => {
  if (sel && sel.provider && sel.model) curModel = { provider: String(sel.provider), model: String(sel.model) };
  else curModel = null;
  return { ok: true, current: modelState() };
});

// ---------- 思考档位 ----------
ipcMain.handle('pi:set-thinking', (_e, level) => {
  curThinking = THINKING_LEVELS.includes(level) ? level : null;
  return { ok: true, current: modelState(), levels: THINKING_LEVELS };
});

// ---------- 已装扩展清单（真跑 pi list，不是写死的表） ----------
function parseExtList(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 形如：  npm:pi-subagents
    //            C:\Users\...\pi-subagents
    const m = /^\s{2}([a-z]+):(\S+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const next = (lines[i + 1] || '').trim();
    out.push({
      source: m[1],
      name: m[2],
      path: /^[A-Za-z]:[\\/]|^\//.test(next) ? next : ''
    });
  }
  return out;
}

ipcMain.handle('pi:agents', async () => {
  const r = await runPiQuery(['list'], 30000, AGENT_DIR);
  return {
    ok: r.ok,
    error: r.error || '',
    raw: (r.out || '').slice(0, 4000),
    extensions: r.ok ? parseExtList(r.out) : [],
    // 自带扩展也算一个（它不是 npm 包，pi list 列不出来）
    local: fs.existsSync(TODO_EXT) ? [{ source: 'local', name: 'todo（PixelAgent 自带）', path: TODO_EXT }] : []
  };
});

// ---------- 设置面板信息（只读部分） ----------
ipcMain.handle('pi:info', () => {
  const loc = bridge.locate();
  return {
    node: loc.node,
    cli: loc.cli,
    session: sessionFile(),
    sessionExists: fs.existsSync(sessionFile()),
    cwd: cfg.workDir,
    agentDir: AGENT_DIR,
    agentDirState,
    mode: 'JSON（换行分隔事件流）',
    current: modelState()
  };
});

// ---------- 设置：读 / 写 / 恢复默认（老板要的"设置要有设置该有的功能"） ----------
// 三层都要能对上，才算"真的能改"：
//   ① 界面改 → ② 存进 .pixelagent.json → ③ 重启后还在（test/verify-settings.js 验的就是这条）
ipcMain.handle('pi:cfg', () => ({
  ok: true, cfg: cfgForUi(), accents: ACCENTS,
  thinkingLevels: THINKING_LEVELS, exportFormats: EXPORT_FORMATS
}));

ipcMain.handle('pi:cfg-set', (_e, patch) => applyCfgPatch(patch));

ipcMain.handle('pi:cfg-reset', () => {
  const names = cfg.names;                       // 会话改名记录不是设置，不清
  cfg = { ...CFG_DEFAULTS, names };
  saveCfg();
  applyModelDefaults();
  return { ok: true, cfg: cfgForUi() };
});

// ---------- 窗口控制（无原生标题栏用） ----------
ipcMain.handle('win:min', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('win:max', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('win:close', () => { if (win && !win.isDestroyed()) win.close(); });

app.whenReady().then(() => {
  ensureAgentDir();     // 首次运行时准备好隔离的 pi 配置目录
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
