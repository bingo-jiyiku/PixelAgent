/* 算 6 个 pi 扩展的运行时依赖闭包（从文件系统真实解析，不猜）：
   对每个扩展的 dependencies 用 require.resolve(paths) 找实际落地目录，
   递归下去，得到"要跟着安装包捆绑的最小集合"。排除 pi 自己。 */
'use strict';
const fs = require('fs');
const path = require('path');

const NPM_DIR = path.join(process.env.USERPROFILE, '.pi', 'agent', 'npm');
const ROOTS = ['pi-background-tasks', 'pi-subagents', 'pi-hermes-memory', 'pi-web-access', 'pi-lens', 'pi-simplify'];
const EXCLUDE_TOP = new Set(['@earendil-works']);   // pi 内核自己，不跟扩展走

const closure = new Set();
const queue = [];

function pkgDirOf(name, fromDir) {
  try {
    const pj = require.resolve(path.join(name, 'package.json'), { paths: [fromDir] });
    return path.dirname(pj);
  } catch (e) { return null; }
}

for (const r of ROOTS) {
  const d = path.join(NPM_DIR, 'node_modules', r);
  if (fs.existsSync(d)) queue.push(d);
}
while (queue.length) {
  const dir = queue.pop();
  if (closure.has(dir)) continue;
  closure.add(dir);
  let pj = null;
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { continue; }
  const deps = Object.assign({}, pj.dependencies || {}, pj.optionalDependencies || {});
  for (const dep of Object.keys(deps)) {
    const dd = pkgDirOf(dep, dir);
    if (!dd) { console.log('  ⚠ 解析不到: ' + dep + ' (from ' + path.basename(dir) + ')'); continue; }
    if (!dd.startsWith(NPM_DIR)) continue;               // 跳出 npm 目录的不要
    const rel = path.relative(path.join(NPM_DIR, 'node_modules'), dd).split(path.sep);
    if (EXCLUDE_TOP.has(rel[0])) continue;                // pi 自己
    queue.push(dd);
  }
}

// 统计体积 + 分级打印
let total = 0;
const rows = [];
for (const d of closure) {
  let size = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      let ents = [];
      try { ents = fs.readdirSync(p); } catch (e) { return; }
      for (const e of ents) walk(path.join(p, e));
    } else size += st.size;
  };
  walk(d);
  total += size;
  rows.push({ p: path.relative(NPM_DIR, d), mb: +(size / 1048576).toFixed(1) });
}
rows.sort((a, b) => b.mb - a.mb);
console.log('闭包含 ' + closure.size + ' 个目录，合计 ' + (total / 1048576).toFixed(1) + ' MB');
rows.slice(0, 25).forEach((r) => console.log('  ' + String(r.mb).padStart(8) + ' MB  ' + r.p));
if (rows.length > 25) console.log('  ... 其余 ' + (rows.length - 25) + ' 个小目录');
// 把清单落盘，给打包脚本用
fs.writeFileSync(path.join(__dirname, '_ext-closure.json'), JSON.stringify(rows.map((r) => r.p), null, 2), 'utf8');
console.log('清单已写 _ext-closure.json');
