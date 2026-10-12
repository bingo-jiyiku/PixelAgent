/* ============================================================
   tools/verify-dist.js —— 安装目录发货验收（dist 链最后一道，不过就 EXIT=1）

   为什么必须有它：
   electron-builder 的 extraResources filter 有条硬规则——
   顶层目录名正好叫 node_modules 的会被整棵排掉
   （app-builder-lib/out/util/filter.js: `if (relative === "node_modules") return false`）。
   所以 {from:"vendor/ext-npm"} 整棵拷的结局是：**只进 manifest 一个文件，
   9000+ 个扩展文件全丢，而且一声都不吭** —— 安装包照样"构建成功"，
   新用户装完依旧一个扩展都没有（正是要解决的那个问题本身）。

   验什么（从结构到功能）：
   ① manifest 在不在
   ② copy 清单里每个顶层包在不在盘上。
      注意 scoped 包（@ast-grep 这种）在 copy 里是**作用域目录**，本身没有
      package.json —— 必须下沉一层跟 vendor 逐一比对子包，否则会误报
      （第一版就因为这连报 7 个 scope，把好包判成坏的）。
   ③ packages 里每个扩展源在不在（pi 按 settings.json 加载，缺了启动就报）
   ④ 文件总量跟 vendor 对得上（防"只进了一部分"的半截包）
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_DIR = process.env.PIXELAGENT_DIST_DIR || path.join(ROOT, 'dist-app', 'win-unpacked');
const RES = path.join(APP_DIR, 'resources');
const EXT = path.join(RES, 'ext-npm');
const NM = path.join(EXT, 'node_modules');
// vendor 是同一份闭包的源头（pack-extensions 刚产出的），拿来逐一比对
const VENDOR_NM = path.join(ROOT, 'vendor', 'ext-npm', 'node_modules');

function fail(msg) {
  console.log('❌ [verify-dist] ' + msg);
  process.exit(1);
}

// 列出某个 node_modules 下"直接子级里是真包的目录"（含 scope 的子包）
function subPackages(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(dir, e.name, 'package.json'))) out.push(e.name);
  }
  return out;
}

// ① manifest
const manFile = path.join(EXT, 'pixelagent-extensions.json');
if (!fs.existsSync(manFile)) fail('resources/ext-npm/pixelagent-extensions.json 不在——扩展库整个没打进包');
let man;
try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch (e) { fail('manifest 读不出：' + e.message); }
if (!Array.isArray(man.copy) || !man.copy.length) fail('manifest 没有 copy 清单（顶层包）');

// ② 每个顶层包在盘上（node_modules 目录本身不在 = 撞上那条 filter 规则）
if (!fs.existsSync(NM)) {
  fail('resources/ext-npm/node_modules 不在——扩展文件一个都没打进去' +
    '（extraResources 的 from 指到 ext-npm 整棵就会被 filter 排掉顶层 node_modules，' +
    '必须拆成 node_modules / manifest 两条，见 package.json extraResources）');
}
const missing = [];
for (const name of man.copy) {
  const dst = path.join(NM, name);
  if (name.startsWith('@')) {
    // scoped：条目是作用域目录，逐一比对其下的真包子包（跟 vendor 对齐，
    // 不猜有哪些子包——猜漏了正是这个门要防的事）
    const vendSubs = subPackages(path.join(VENDOR_NM, name));
    if (vendSubs == null) { missing.push(name + '（vendor 里也没有？）'); continue; }
    const dstSubs = new Set(subPackages(dst) || []);
    for (const s of vendSubs) if (!dstSubs.has(s)) missing.push(name + '/' + s);
  } else if (!fs.existsSync(path.join(dst, 'package.json'))) {
    missing.push(name);
  }
}
if (missing.length) fail('缺 ' + missing.length + ' 个包：' + missing.slice(0, 12).join(' '));

// ③ 扩展源本人（pi 启动时按 settings.json 的 packages 找它们）
const srcs = Array.isArray(man.packages) ? man.packages : [];
const missSrc = srcs.filter((p) => !fs.existsSync(path.join(NM, p.replace(/^npm:/, ''), 'package.json')));
if (missSrc.length) fail('缺扩展源：' + missSrc.join(' '));

// ④ 总量跟 vendor 对得上（半截包在这现形；不要求逐一相等，留一点余量防误报）
function countFiles(dir) {
  let n = 0;
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else n++;
    }
  })(dir);
  return n;
}
const dstFiles = countFiles(EXT);
const srcFiles = countFiles(path.join(ROOT, 'vendor', 'ext-npm'));
if (dstFiles < srcFiles * 0.9) {
  fail('ext-npm 只打进 ' + dstFiles + ' / ' + srcFiles + ' 个文件（不足 90%）——扩展库没打全');
}

console.log('✅ [verify-dist] 扩展库验收通过：' + dstFiles + '/' + srcFiles + ' 个文件 / ' +
  man.copy.length + ' 个顶层包 / ' + srcs.length + ' 个扩展源');
