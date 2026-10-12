/* 生成应用图标（老板 2026-10-11：用「像素」立绘当图标）
 *
 * 输入 assets/icon-src.png（1024 白底立绘）
 *   ↓ 1) flood-fill 只抠「连通到图片边缘的白」→ 外围透明；领子/白袜这些
 *      被人物包住的白不碰（全局抠白会把领子抠出洞，任务栏深色底会穿帮）
 *   ↓ 2) 存 assets/icon.png（1024 透明底，渲染窗口/网页可复用）
 *   ↓ 3) 最近邻缩放 7 档（16/24/32/48/64/128/256）——像素风缩放要保方边，
 *      平滑插值会把像素描边糊掉
 *   ↓ 4) png-to-ico 打成 build/icon.ico（dev 窗口 icon + 以后打包用）
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pngToIco = require('png-to-ico').default;  // 该包是 ESM：{__esModule, default}，须取 .default

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon-src.png');
const OUT_PNG = path.join(ROOT, 'assets', 'icon.png');
const OUT_ICO = path.join(ROOT, 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const src = PNG.sync.read(fs.readFileSync(SRC));
const W = src.width, H = src.height;
const out = new PNG({ width: W, height: H });
out.data.set(src.data);

// ---------- 1) 边缘连通白 → 透明（BFS，四角四边全部种子入队） ----------
const idx = (x, y) => (y * W + x) * 4;
const isWhite = (i) => src.data[i] >= 245 && src.data[i + 1] >= 245 && src.data[i + 2] >= 245;
const seen = new Uint8Array(W * H);
const queue = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = y * W + x;
  if (seen[p]) return;
  seen[p] = 1;
  if (!isWhite(idx(x, y))) return;   // 遇到人物描边就停
  queue.push([x, y]);
  out.data[idx(x, y) + 3] = 0;       // 外围白 → 全透明
};
for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
while (queue.length) {
  const [x, y] = queue.pop();
  push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
}
// 半透明白晕边：紧贴透明区的浅白像素（抗锯齿过渡带）降透明度，任务栏上不显白圈
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (out.data[idx(x, y) + 3] === 0) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) {
      for (let dx = -1; dx <= 1 && !near; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (out.data[idx(nx, ny) + 3] === 0 && isWhite(idx(x, y))) near = true;
      }
    }
    if (near) out.data[idx(x, y) + 3] = 0;
  }
}
// ---------- 1b) 自动裁边 + 铺满画布（老板 2026-10-11：图标里人太小） ----------
// 立绘四周留白太多 → 按非透明像素的包围盒裁出来，居中铺满画布（四周留 4% 边距），
// 小尺寸下人也醒目
const ALPHA_TH = 16;
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (out.data[idx(x, y) + 3] >= ALPHA_TH) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }  // 全透明兜底（不该发生）
const bw = maxX - minX + 1, bh = maxY - minY + 1;
const MARGIN = 0.04;                                   // 四周各留 4%，顶天立地太挤
const side = Math.ceil(Math.max(bw, bh) / (1 - MARGIN * 2));
const filled = new PNG({ width: side, height: side });
const ox = Math.floor((side - bw) / 2), oy = Math.floor((side - bh) / 2);
for (let y = 0; y < bh; y++) {
  for (let x = 0; x < bw; x++) {
    const si = idx(minX + x, minY + y), di = ((oy + y) * side + (ox + x)) * 4;
    filled.data[di] = out.data[si];
    filled.data[di + 1] = out.data[si + 1];
    filled.data[di + 2] = out.data[si + 2];
    filled.data[di + 3] = out.data[si + 3];
  }
}
console.log('trim:', bw + 'x' + bh, '-> canvas', side + 'x' + side);
fs.writeFileSync(OUT_PNG, PNG.sync.write(filled));

// ---------- 2) 最近邻缩放（正方形画布 side×side → size×size） ----------
function resize(png, side, size) {
  const r = new PNG({ width: size, height: size });
  const idxS = (x, y) => (y * side + x) * 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(side - 1, Math.floor((x * side) / size));
      const sy = Math.min(side - 1, Math.floor((y * side) / size));
      const si = idxS(sx, sy), di = (y * size + x) * 4;
      r.data[di] = png.data[si];
      r.data[di + 1] = png.data[si + 1];
      r.data[di + 2] = png.data[si + 2];
      r.data[di + 3] = png.data[si + 3];
    }
  }
  return PNG.sync.write(r);
}

// ---------- 3) 打 ico ----------
(async () => {
  const files = SIZES.map((s) => resize(filled, side, s));
  const ico = await pngToIco(files);
  fs.writeFileSync(OUT_ICO, ico);
  console.log('icon ok:', OUT_ICO, '(', OUT_PNG, ') sizes:', SIZES.join('/'));
})().catch((e) => { console.error('icon fail:', e.message); process.exit(1); });
