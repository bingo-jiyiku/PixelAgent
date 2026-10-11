/* ============================================================
   tools/girl-profile.js —— 量出人物 PNG 的真实轮廓
   ------------------------------------------------------------
   跑法：node tools/girl-profile.js [girl.png]

   为什么要有它：
   办公室场景是**纯几何对齐**（椅子会不会从人物身后露出一块、
   键盘是不是正对着她的身子），这些靠"看整屏图"根本判断不准 ——
   整屏图在对话框里是缩过的，差十几个像素看不出来。
   这里直接把每一行的不透明像素范围打出来，让"椅子该多窄"变成数字。

   复用 make-girl.js 的 decodePng（同一套解码，不另写一份）。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { decodePng } = require('./make-girl');

const file = process.argv[2] || path.join(__dirname, '..', 'assets', 'girl.png');
const img = decodePng(fs.readFileSync(file));
const { w, h, data } = img;
const A = (x, y) => data[(y * w + x) * 4 + 3];

// 每行的不透明范围
const rows = [];
let gx0 = w, gx1 = -1, gy0 = h, gy1 = -1;
for (let y = 0; y < h; y++) {
  let l = -1, r = -1;
  for (let x = 0; x < w; x++) if (A(x, y) >= 8) { if (l < 0) l = x; r = x; }
  rows.push({ y, l, r });
  if (l >= 0) { if (l < gx0) gx0 = l; if (r > gx1) gx1 = r; if (y < gy0) gy0 = y; if (y > gy1) gy1 = y; }
}

console.log(`图 ${file}`);
console.log(`尺寸 ${w}×${h}   不透明外框 x ${gx0}..${gx1} (${gx1 - gx0 + 1}宽)  y ${gy0}..${gy1} (${gy1 - gy0 + 1}高)`);
console.log('\n各行轮廓（每 5% 高取一行；l/r 是从左/右数的不透明像素下标）');
console.log('  y    占高    左l   右r   宽    距左 距右');
const step = Math.max(1, Math.round(h / 20));
for (let y = 0; y < h; y += step) {
  const r0 = rows[y];
  const pct = ((y / h) * 100).toFixed(0).padStart(4);
  if (r0.l < 0) { console.log(`  ${String(y).padStart(4)} ${pct}%   ——（整行透明）`); continue; }
  console.log(`  ${String(y).padStart(4)} ${pct}%  ${String(r0.l).padStart(5)} ${String(r0.r).padStart(5)} ${String(r0.r - r0.l + 1).padStart(5)}  ${String(r0.l).padStart(5)} ${String(w - 1 - r0.r).padStart(5)}`);
}

// 最宽/最窄的关键高度：给 CSS 定位用
const widest = rows.reduce((a, b) => ((b.l < 0 || (b.r - b.l) < (a.r - a.l)) ? a : b));
console.log(`\n最宽一行：y=${widest.y} (${((widest.y / h) * 100).toFixed(0)}% 高)  x ${widest.l}..${widest.r}  宽 ${widest.r - widest.l + 1}`);
// 下半身（裙摆/腿）的宽度：取 78% 高那一行
const ly = Math.round(h * 0.78), lr = rows[ly];
if (lr.l >= 0) console.log(`78% 高处（裙摆）：x ${lr.l}..${lr.r}  宽 ${lr.r - lr.l + 1}  → 这是"桌面要盖住的宽度"`);

// 宽度随高度变化，找出"从宽变窄"的拐点：马尾结束、只剩身子的位置
console.log('\n细分：每 2% 高的宽度（找"马尾结束、只剩身子"的拐点）');
const s2 = Math.max(1, Math.round(h / 50));
let prev = null;
for (let y = 0; y < h; y += s2) {
  const r0 = rows[y];
  if (r0.l < 0) continue;
  const wd = r0.r - r0.l + 1;
  if (prev != null && Math.abs(wd - prev) > 18) {
    console.log(`  ⬅ y=${y} (${((y / h) * 100).toFixed(0)}%) 宽度突变 ${prev} → ${wd}`);
  }
  prev = wd;
}
