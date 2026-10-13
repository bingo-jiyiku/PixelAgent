/* ============================================================
   tools/pack-extensions.js —— 把本机 pi 的 npm 扩展打成安装包种子
   跑法：node tools/pack-extensions.js        （dist 前必须跑，产出 vendor/ext-npm/）

   做什么：
   ① 从 ~/.pi/agent/settings.json 的 packages 读"启用中的扩展"（权威清单）
   ② 用 require.resolve 从每个扩展出发走**真实运行时依赖闭包**
      （不猜依赖 —— 猜漏了扩展在新机器上当场报错，猜多了安装包白胖）
   ③ 剪枝：better-sqlite3 的 C 源码/prebuilds 多余 ABI、build/.git/test 目录
   ④ 硬链接去重：npm 给 @ast-grep 的平台包做了硬链接，按 (dev,ino) 跳过已拷的
      （不去重会白拷 100MB 相同的 exe）
   ⑤ 产出 vendor/ext-npm/node_modules/... + pixelagent-extensions.json（manifest）
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOME = process.env.USERPROFILE || process.env.HOME;
// 🔴 两个来源，缺一不可（老板 2026-10-13：「新版本没有的插件也加上」）：
//   ~/.pi/agent/npm        开发版 pi 自己管的扩展（打包脚本原来的唯一来源）
//   ~/.pixelagent/agent/npm 打包版播种 + 用户后来自己装的
// 原来只看 .pi，于是**在打包版里启用过的扩展每次发版都消失**（老板机器上
// pi-agnes-tools / billion-context / pi-cache-optimizer 就是这么丢的）。
// 顺序有意义：同名包以先到的为准（.pi 优先），不改变原有行为。
const NPM_DIRS = [
  path.join(HOME, '.pi', 'agent', 'npm'),
  path.join(HOME, '.pixelagent', 'agent', 'npm')
].filter((d) => fs.existsSync(d));
const OUT_DIR = path.join(ROOT, 'vendor', 'ext-npm');
const SETTINGS_FILES = NPM_DIRS.map((d) => path.join(d, '..', 'settings.json'));

// 剪枝规则：目录名命中就整个跳过（都是运行时不要的）
const PRUNE_DIRS = new Set(['.git', '.github', 'build', 'test', 'tests', '__tests__', '.cache']);
// 文件后缀命中就跳过
const PRUNE_EXTS = new Set(['.md', '.markdown', '.map', '.ts', '.mts', '.cts']);
// 这两个包的源码/prebuild 运行时不要（.node 由 lib/ 按 ABI 挑，这里只发 win-x64）
const PRUNE_SUBPATHS = [
  path.join('better-sqlite3', 'deps'),
  path.join('better-sqlite3', 'src')
];

function fail(msg) { console.log('❌ ' + msg); process.exit(1); }

if (!NPM_DIRS.length) fail('找不到任何 pi 扩展目录（.pi/agent/npm 或 .pixelagent/agent/npm）');

// ① 启用中的扩展：**两处 settings.json 合并**（只认 npm: 前缀；本地路径源不跟安装包走）
//   合并而不是二选一：开发版清单是"我开发时启用的"，打包版清单是"这台机器实际在用的"，
//   后者常有前者没有的扩展（老板在打包版里 pi add 装的），漏了就等于发版把它们抹掉。
let enabled = [];
for (const f of SETTINGS_FILES) {
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = (Array.isArray(s.packages) ? s.packages : []).filter((p) => /^npm:/.test(p));
    for (const p of list) if (!enabled.includes(p)) enabled.push(p);   // 去重且保序
  } catch (e) { /* 这个源没有/读不了就跳过，另一个源仍然权威 */ }
}
if (!enabled.length) fail('两处 settings.json 里都没找到启用中的 npm 扩展');
console.log('启用中的扩展（' + enabled.length + '，来自 ' + SETTINGS_FILES.length + ' 处配置）：' + enabled.join(' '));

const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 已就绪守卫：vendor 里的产物版本 + 扩展清单都对得上就跳过重打
// （整树一次 rmSync 9000+ 文件，又慢又会撞批量删除护栏；清单没变就不重打。
//   依赖小版本漂移要重捆时：PIXELAGENT_EXT_FORCE=1 node tools/pack-extensions.js）
if (!process.env.PIXELAGENT_EXT_FORCE) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pixelagent-extensions.json'), 'utf8')); } catch (e) {}
  if (prev && prev.app === appPkg.version && JSON.stringify(prev.packages) === JSON.stringify(enabled)) {
    console.log('✅ 已就绪（vendor/ext-npm：v' + appPkg.version + ' / ' + enabled.length + ' 个扩展），跳过重打');
    process.exit(0);
  }
  if (prev) console.log('ℹ 版本号变了（v' + prev.app + ' → v' + appPkg.version + '），看闭包要不要重打…');
}

// ② 真实闭包（两个 npm 目录都能解析：扩展本体和它的依赖可能分处两边）
const closure = new Set();      // 绝对目录路径（待拷）
const closureTop = new Set();   // 顶层包名（**跨目录去重**：同名包只拷一份，.pi 优先）
const queue = [];
const unresolved = [];
// 平台变体（<包名>-<平台>-<架构>[...]）在只发 win-x64 的包里必然缺，属正常。
// 用于过滤 optionalDependencies 里解析不到的那批（dependencies 里缺一律是错）。
const PLATFORM_VARIANT = /^(@[^/]+\/)?[^/]+-(win32|linux|darwin|android|freebsd|netbsd|openbsd|sunos|haiku)-(x64|ia32|arm64|arm|armv7l|ppc64|ppc64le|riscv64|s390x|s390|loong64|mips64|mips64el|wasm32)([-._].*)?$/;
let optSkipped = 0;

function nmUnder(base) { return path.join(base, 'node_modules'); }
function inAnyNm(absDir) {
  return NPM_DIRS.some((b) => absDir.startsWith(nmUnder(b) + path.sep));
}
// 顶层包名（相对它自己所在的 node_modules）：pi-agnes-tools / @scope/pkg / @scope/pkg/sub
function topOf(absDir) {
  for (const b of NPM_DIRS) {
    const nm = nmUnder(b);
    if (absDir.startsWith(nm + path.sep)) return path.relative(nm, absDir).split(path.sep)[0];
  }
  return path.basename(absDir);
}
// 两个目录里按优先级找
function locate(topName) {
  for (const b of NPM_DIRS) {
    const d = path.join(nmUnder(b), topName);
    if (fs.existsSync(d)) return d;
  }
  return null;
}
function pushTop(topName, fromDir) {
  if (closureTop.has(topName)) return;
  const d = locate(topName);
  if (!d) { unresolved.push(topName + ' (from ' + path.basename(fromDir) + ')'); return; }
  closureTop.add(topName);
  queue.push(d);
}

for (const p of enabled) pushTop(p.replace(/^npm:/, ''), 'settings');

while (queue.length) {
  const dir = queue.pop();
  if (closure.has(dir)) continue;
  closure.add(dir);
  let pj = null;
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { continue; }
  const optDeps = pj.optionalDependencies || {};
  for (const dep of Object.keys(Object.assign({}, pj.dependencies, pj.optionalDependencies))) {
    let r = null;
    try { r = require.resolve(path.join(dep, 'package.json'), { paths: [dir] }); } catch (e) { r = null; }
    if (!r) {
      // 缺失分两类，处理方式按 **npm 语义**而不是"我猜哪些是平台变体"：
      //  ① optionalDependencies 里缺失 → 放行（npm 官方语义：optional 装不上也能跑；
      //     而 @img/sharp-* / @ast-grep/*-* 这类几乎全在 optional 里，只发 win-x64 一个平台）。
      //     ⚠ 原来靠一个 @ast-grep 硬编码白名单，加带 sharp 的扩展后直接卡死；
      //       平台形态是 linuxmusl / webcontainers / musl… 穷举永远漏（2026-10-13 实测）。
      //  ② dependencies 里缺失 → 真缺失，必须报出来（新机器上当场 Cannot find module）。
      const isOptional = Object.prototype.hasOwnProperty.call(optDeps, dep);
      if (isOptional || PLATFORM_VARIANT.test(dep)) { optSkipped++; continue; }
      unresolved.push(dep + ' (from ' + path.basename(dir) + ')');
      continue;
    }
    const dd = path.dirname(r);
    if (!inAnyNm(dd)) continue;          // 解析到 npm 全局目录等第三方地方 → 不捆
    const top = topOf(dd);
    if (top === '@earendil-works') continue;   // pi 内核自己走 vendor/pi，不重复捆
    pushTop(top, dir);
  }
}

// 🔴 守卫：optional 里的平台变体已就地放过，剩下的解析不到一律是**真缺失**，
// 打进去新机器上扩展当场 "Cannot find module"。别删这条（我改白名单时顺手删过一次）。
if (unresolved.length) {
  fail('有依赖解析不到，打进去会是坏的：\n  ' + unresolved.join('\n  '));
}
if (optSkipped) console.log("ℹ 已跳过 " + optSkipped + " 个可选依赖（非本机平台，不进包）");

// 第二条守卫：只有**版本号**变了、扩展清单和闭包顶层集合都没变（发新版 bump
// version 的典型场景）→ 只把 manifest 的 app 字段原位改掉，不重打。
// 没有这条，每次发新版都要手动改名 vendor/ext-npm 躲批量删除护栏。
// 依赖内容真变了（同集合不同版本）要重捆时：PIXELAGENT_EXT_FORCE=1。
// ⚠ 位置有讲究：必须在 rmSync **之前**（闭包②已经算完，顶层集合现成），
//   插到 byTop 后面就永远轮不到——rmSync 在 byTop 前面就炸了。
if (!process.env.PIXELAGENT_EXT_FORCE && fs.existsSync(OUT_DIR)) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pixelagent-extensions.json'), 'utf8')); } catch (e) {}
  const copyNow = [...closureTop].sort();
  if (prev && JSON.stringify(prev.packages) === JSON.stringify(enabled)
      && JSON.stringify((prev.copy || []).slice().sort()) === JSON.stringify(copyNow)) {
    fs.writeFileSync(path.join(OUT_DIR, 'pixelagent-extensions.json'), JSON.stringify({
      app: appPkg.version,
      packages: enabled,
      copy: copyNow,
      note: prev.note || 'PixelAgent 捆绑的 pi 扩展；首次运行播种到 ~/.pixelagent/agent/npm。'
    }, null, 2));
    console.log('✅ 扩展闭包没变（只版本号 v' + prev.app + ' → v' + appPkg.version +
      '，' + copyNow.length + ' 个顶层包），manifest 原位更新，跳过重打');
    process.exit(0);
  }
  console.log('⚠ 扩展清单或闭包变了（v' + (prev ? prev.app : '?') + ' → v' + appPkg.version + '），整树重打…');
}

// ③④ 拷贝（剪枝 + 硬链接去重）
if (fs.existsSync(OUT_DIR)) {
  try {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  } catch (e) {
    fail('清不掉旧产物 ' + OUT_DIR + '：' + e.message +
      '\n   手动删掉它再跑：rmdir /s /q "' + OUT_DIR + '"');
  }
}
const seenInode = new Set();
let files = 0, bytes = 0, skipped = 0;

// 相对路径要按**包自己所在的目录**算：两个来源的包都要落成 npm 的规范嵌套结构
// （pi-agnes-tools → pi-agnes-tools；@scope/pkg/sub → @scope/pkg/sub）。
function relOf(p) {
  for (const b of NPM_DIRS) {
    const nm = nmUnder(b);
    if (p.startsWith(nm + path.sep)) return path.relative(nm, p);
  }
  return path.basename(p);
}

function shouldPruneDir(rel) {
  const segs = rel.split(path.sep);
  for (const s of segs) if (PRUNE_DIRS.has(s)) return true;
  for (const sub of PRUNE_SUBPATHS) {
    const subSegs = sub.split(path.sep);
    if (segs.length >= subSegs.length && subSegs.every((x, i) => segs[i] === x)) {
      // better-sqlite3/deps 整棵剪掉；但 better-sqlite3/prebuilds 要按 ABI 挑（见文件级剪枝）
      return true;
    }
  }
  return false;
}

function shouldPruneFile(rel) {
  if (PRUNE_EXTS.has(path.extname(rel).toLowerCase())) {
    // 例外：扩展自己的 .ts 是入口（pi-hermes-memory 的 main 就是 src/index.ts），不能剪
    const top = rel.split(path.sep)[0];
    const isExt = enabled.some((p) => top === p.replace(/^npm:/, ''));
    if (!isExt) return true;
  }
  // better-sqlite3 只留 win32-x64 的 prebuild
  if (/^better-sqlite3[\\/]prebuilds[\\/]/.test(rel) && !/win32-x64/.test(rel)) return true;
  return false;
}

function copyTree(src, dst, rel) {
  let ents;
  try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const r = rel ? rel + path.sep + e.name : e.name;
    if (e.isDirectory()) {
      if (shouldPruneDir(r)) { skipped++; continue; }
      copyTree(path.join(src, e.name), path.join(dst, e.name), r);
    } else if (e.isFile()) {
      if (shouldPruneFile(r)) { skipped++;
        continue; }
      let st;
      try { st = fs.lstatSync(path.join(src, e.name)); } catch (err) { continue; }
      const key = st.dev + ':' + st.ino;
      if (seenInode.has(key)) { skipped++; continue; }   // 硬链接去重
      seenInode.add(key);
      try {
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
        files++; bytes += st.size;
      } catch (err) { console.log('  ⚠ 拷不动：' + r + ' (' + err.message + ')'); }
    }
  }
}

// 闭包里可能同时有嵌套目录（a/node_modules/b）——按顶层包名分组拷，保留嵌套结构
const byTop = new Map();
for (const d of closure) {
  const rel = relOf(d);
  const top = rel.split(path.sep)[0];
  if (!byTop.has(top)) byTop.set(top, []);
  byTop.get(top).push(d);
}

console.log('闭包 ' + closure.size + ' 个目录 / ' + byTop.size + ' 个顶层包，开拷…');
for (const [top, dirs] of byTop) {
  for (const d of dirs) {
    const rel = relOf(d);
    copyTree(d, path.join(OUT_DIR, 'node_modules', rel), rel);
  }
}

// ⑤ manifest 两个清单，别混为一谈：
//   packages —— 扩展源（进 settings.json 让 pi 加载的，就是启用中的那几个）
//   copy     —— 要往磁盘播种的**所有顶层包**（含 217 个依赖；只拷扩展名会漏依赖，
//               新机器上扩展当场 "Cannot find module"）
const copyList = [...byTop.keys()].sort();
fs.writeFileSync(path.join(OUT_DIR, 'pixelagent-extensions.json'),
  JSON.stringify({
    app: appPkg.version,
    packages: enabled,
    copy: copyList,
    note: 'PixelAgent 捆绑的 pi 扩展；首次运行播种到 ~/.pixelagent/agent/npm。packages=扩展源（合进 settings.json），copy=全部顶层包（含依赖）'
  }, null, 2));

console.log('\n✅ 打包完成 → ' + path.relative(ROOT, OUT_DIR));
console.log('   ' + files + ' 个文件 / ' + (bytes / 1048576).toFixed(1) + ' MB（剪掉 ' + skipped + ' 项）');
console.log('   manifest: ' + enabled.length + ' 个扩展 / ' + copyList.length + ' 个待播种包');
