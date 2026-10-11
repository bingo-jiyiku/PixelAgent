/* ============================================================
   test/audit-copy.js —— 界面文案"英文残留"审计（源码级，**辅助工具**）
   ------------------------------------------------------------
   跑法：node test/audit-copy.js      （或 npm run audit:copy，也挂在 npm test 末尾）

   ⚠️ 先说清能力边界，别把它当主验证：
   这是**源码级形状检查**，只能扫出"字面量里还写着英文"。
   真正的判据是 test/verify-features.js 的 [7] 中文体检 ——
   那条读的是**渲染出来的 DOM 文字**，是行为断言。

   那为什么还要留它？因为它能覆盖 **DOM 断言跑不到的代码路径**。
   实测教训：Markdown 代码块右上角的复制按钮，文案是从 md.js 里
   拼出来的，只有"消息里恰好含代码块"时才存在于 DOM。
   [7] 第一版没喂代码块，于是 "COPY" 一直留着没人发现。
   源码级扫一遍就能立刻看见。

   它会**自动跳过**两类"不是文案"的字符串：
     ① 拼接碎片（以标点开头/结尾，如 ").join("）；
     ② 比较上下文里的内部值（=== / !== / case / e.key / .type …）。
   剩下进入白名单的，都是**有意保留**的，分两组写清理由：
     PUBLIC_KEEP  —— 用户看得见，但是专有名词（PixelAgent / pi / JSON / ESC）
     INTERNAL_KEEP—— 用户看不见的内部值（二进制魔数 / IPC 通道名 / 路径签名）
   往白名单里加词前先问一句：用户会不会在界面上看到它？
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 用户能看到的文案在这几个文件里生成（main.js 的 pi:info / 报错文案也算）
// pal.js 也在里面：分组标题（"最近使用"）、"回车执行"、参数提示都是它给的
const FILES = ['renderer.js', 'md.js', 'main.js', 'attach.js', 'parse.js', 'preload.js', 'pi-bridge.js', 'pal.js'];
const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

// 用户看得见、但有意保留的专有名词
const PUBLIC_KEEP = new Set(['PixelAgent', 'PIXELAGENT', 'pi', 'JSON', 'ESC', 'HTML']);
// 用户看不见的内部值：二进制魔数、mime、IPC/CLI 标识、路径片段、抽屉按钮的 props、事件键名
const INTERNAL_KEEP = new Set([
  'Files', 'image/*', 'image/svg+xml',            // DataTransfer.types / mime
  'GIF87a', 'GIF89a', 'IHDR', 'IDAT', 'IEND', 'RIFF', 'WEBP', // 图片魔数（比对用）
  'PIXELTODOS:',                                  // 自带 todo 扩展的 stdout 协议前缀
  'pixelAPI', 'toolResult', 'openDirectory', 'createDirectory', // IPC 名 / pi 事件字段 / 选目录 props
  '@earendil-works', 'E:/npm-global',             // 包名 / 本机 pi 安装路径
  'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Tab' // KeyboardEvent.key 值
]);
// 内部"词汇表"：消息标签 / 状态值 / 错误码 / 快捷键。
// 这些字面量**不会单独显示给用户**（显示前都过 WHO_ZH / STATE_ZH / REASON_ZH / TH_ZH 翻译），
// 但它们在源码里长得像英文标签，所以必须显式声明，否则工具会一直报噪音。
const INTERNAL_TOKENS = new Set(('use strict,IDLE,THINKING,TOOL,DONE,SYS,ERR,IMG,YOU,PI,STOP,SHELL,' +
  'BUSY,EMPTY,BAD_SEQ,NOT_FOUND,TRASH_FAILED,NO_WINDOW,CANCELED,EXPORT_FAILED,NOT_DIR,SPAWN_FAILED,' +
  'IMAGE_REJECTED,unknown,on,del,off,minimal,low,medium,high,xhigh,max,' +
  'NAME_TAKEN,NAME_EMPTY,html,md,json').split(','));
const KEEP = new Set([...PUBLIC_KEEP, ...INTERNAL_KEEP]);
const keepLc = new Set([...KEEP].map((s) => s.toLowerCase()));
const tokenLc = new Set([...INTERNAL_TOKENS].map((s) => s.toLowerCase()));

// 比较上下文 → 是内部值，不是文案
const CMP_BEFORE = /(===|!==|==|!=|case|\bindexOf\s*\(|\bincludes\s*\(|\bhas\s*\(|\btest\s*\(|\bkey\s*===|\bkey\s*!==)\s*'?$/;

// CSS 类名串：全小写单词/短横线/空格（"m bot"、"att-warn note"、"t-body hidden"、"use strict"）
const isClassToken = (s) => /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(s);

// 一个字符串"像给用户看的文案"吗（只判**单段文本**，不含 HTML 标签）
function looksLikeCopy(s, ctx) {
  if (CJK.test(s)) return false;                       // 已中文，不管
  if (!/[A-Za-z]{3,}/.test(s)) return false;           // 没有成词的字母
  if (KEEP.has(s) || keepLc.has(s.toLowerCase())) return false;
  if (INTERNAL_TOKENS.has(s) || tokenLc.has(s.toLowerCase())) return false;
  if (CMP_BEFORE.test(ctx)) return false;              // 比较用内部值
  if (isClassToken(s)) return false;                   // CSS 类名 / 内部小写串
  // 拼接碎片：以非字母数字开头或结尾（").join(" / " + x + " / ", a: " …）
  if (!/^[A-Za-z0-9]/.test(s) || !/[A-Za-z0-9)]$/.test(s)) return false;
  if (/\{\}|=>/.test(s)) return false;
  // 全小写的选择器 / 属性 / 标识符串
  if (/^[a-z][\w./\\:-]*$/.test(s)) return false;
  return true;
}

// 一条字面量可能是一整段 HTML（'<button …>COPY</button>'）。
// ⚠️ 上一版直接"含 < 就整条跳过"，于是 md.js 里那个用户看得见的
//    ">COPY<" 被一起跳掉了 —— 反向验证时它假绿。
// 正确做法：把标签剥掉，对剩下的每段**文本节点**逐个判。
function copiesInside(lit, ctx) {
  if (!/[<>]/.test(lit)) return looksLikeCopy(lit, ctx) ? [lit] : [];
  return lit.replace(/<[^>]*>/g, '\u0000').split('\u0000')
    .map((x) => x.trim()).filter(Boolean)
    .filter((x) => looksLikeCopy(x, ctx));
}

let hits = 0;
const report = (title, arr) => {
  if (!arr.length) return;
  hits += arr.length;
  console.log('=== ' + title + ' (' + arr.length + ') ===');
  arr.forEach((x) => console.log('  ⚠ ' + x));
};

for (const f of FILES) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;       // 整行注释
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    const scan = (re) => {
      let m;
      while ((m = re.exec(code))) {
        const ctx = code.slice(0, m.index);
        copiesInside(m[1], ctx).forEach((x) => out.push((i + 1) + ': ' + JSON.stringify(x)));
      }
    };
    scan(/'([^'\\\n]{2,90})'/g);
    scan(/"([^"\\\n]{2,90})"/g);
  });
  report(f, out);
}

// index.html：文本节点 + 提示属性
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
const nodes = noScript.replace(/<[^>]*>/g, '\u0000').split('\u0000').map((s) => s.trim()).filter(Boolean);
report('index.html 文本节点', nodes.filter((s) => /[A-Za-z]{2,}/.test(s) && !CJK.test(s) && !KEEP.has(s))
  .map((s) => JSON.stringify(s)));
const attrs = [];
const reA = /(title|placeholder|aria-label)="([^"]*)"/g;
let ma;
while ((ma = reA.exec(html))) {
  const v = ma[2];
  if (v && /[A-Za-z]{2,}/.test(v) && !CJK.test(v) && !KEEP.has(v)) attrs.push(ma[1] + '=' + JSON.stringify(v));
}
report('index.html 属性提示', attrs);

console.log('\n扫了 ' + FILES.length + ' 个 js + index.html');
if (hits) { console.log('❌ 发现 ' + hits + ' 处疑似英文文案 —— 要么改中文，要么加进白名单并写清理由'); process.exit(1); }
console.log('✅ 源码级没发现英文文案残留（DOM 级验证见 verify-features.js 的 [7]）');
