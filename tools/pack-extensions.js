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
const NPM_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'agent', 'npm');
const OUT_DIR = path.join(ROOT, 'vendor', 'ext-npm');
const SETTINGS = path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'agent', 'settings.json');

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

if (!fs.existsSync(NPM_DIR)) fail('找不到 ' + NPM_DIR + '（本机没装过 pi 扩展？）');

// ① 启用中的扩展（只认 npm: 前缀；本地路径源不跟安装包走）
let enabled = [];
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  enabled = (Array.isArray(s.packages) ? s.packages : []).filter((p) => /^npm:/.test(p));
} catch (e) { fail('读不了 settings.json：' + e.message); }
if (!enabled.length) fail('settings.json 里没有启用中的 npm 扩展');
console.log('启用中的扩展（' + enabled.length + '）：' + enabled.join(' '));

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

// ② 真实闭包
const closure = new Set();
const queue = [];
const unresolved = [];
for (const p of enabled) queue.push(path.join(NPM_DIR, 'node_modules', p.replace(/^npm:/, '')));
while (queue.length) {
  const dir = queue.pop();
  if (closure.has(dir) || !fs.existsSync(dir)) continue;
  closure.add(dir);
  let pj = null;
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { continue; }
  for (const dep of Object.keys(Object.assign({}, pj.dependencies, pj.optionalDependencies))) {
    let r = null;
    try { r = require.resolve(path.join(dep, 'package.json'), { paths: [dir] }); } catch (e) { r = null; }
    if (!r) { unresolved.push(dep + ' (from ' + path.basename(dir) + ')'); continue; }
    const dd = path.dirname(r);
    if (!dd.startsWith(NPM_DIR)) continue;
    const rel = path.relative(path.join(NPM_DIR, 'node_modules'), dd).split(path.sep);
    if (rel[0] === '@earendil-works') continue;   // pi 内核自己走 vendor/pi，不重复捆
    queue.push(dd);
  }
}
// 平台专属的可选依赖解析不到是正常的（只发 win-x64），其余的必须报出来
const OPTIONAL_PLATFORM = /^@ast-grep\/(cli|napi)-(?!win32-x64)/;
const realMiss = unresolved.filter((u) => !OPTIONAL_PLATFORM.test(u.split(' ')[0]));
if (realMiss.length) fail('有依赖解析不到，打进去会是坏的：\n  ' + realMiss.join('\n  '));

// 第二条守卫：只有**版本号**变了、扩展清单和闭包顶层集合都没变（发新版 bump
// version 的典型场景）→ 只把 manifest 的 app 字段原位改掉，不重打。
// 没有这条，每次发新版都要手动改名 vendor/ext-npm 躲批量删除护栏。
// 依赖内容真变了（同集合不同版本）要重捆时：PIXELAGENT_EXT_FORCE=1。
// ⚠ 位置有讲究：必须在 rmSync **之前**（闭包②已经算完，顶层集合现成），
//   插到 byTop 后面就永远轮不到——rmSync 在 byTop 前面就炸了。
if (!process.env.PIXELAGENT_EXT_FORCE && fs.existsSync(OUT_DIR)) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pixelagent-extensions.json'), 'utf8')); } catch (e) {}
  const nmRoot0 = path.join(NPM_DIR, 'node_modules');
  const copyNow = [...new Set([...closure].map((d) => path.relative(nmRoot0, d).split(path.sep)[0]))].sort();
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
const nmRoot = path.join(NPM_DIR, 'node_modules');

function relOf(p) { return path.relative(nmRoot, p); }

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
