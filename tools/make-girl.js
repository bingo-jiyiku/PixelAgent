/* ============================================================
   tools/make-girl.js —— 把吉祥物原图抠成透明底并裁到人物外框
   ------------------------------------------------------------
   跑法：node tools/make-girl.js <输入.png> [输出.png]
        默认：assets/girl-src.png → assets/girl.png

   为什么不用在线抠图 / 生成模型：
   老板要的是"用这个形象"，那就不该让任何模型去**重画**它 ——
   重画一定会改细节（发绳、蝴蝶结、裙褶配色都跑过）。
   这里只做两件纯机械的事：**去白底 + 裁边**，像素一个都不动。

   算法（针对"厚描边 + 纯白底"的 chibi 立绘，正是这类图的通用做法）：
   1) 从**四条边**做 BFS 泛洪，把连通的近白像素判为背景。
      —— 关键在"从边泛洪"而不是"把白色全删"：像白袜子、白裙条这种
      **被描边围住**的白，与外界不连通，一个都不会误删。
   2) 只对"紧贴透明区"的像素做羽化（按亮度给部分透明度），
      把描边抗锯齿留在白底上的那圈浅灰擦掉，避免放到深色面板上出现白边。
      内部的白不受影响（它们不贴透明区）。
   3) 按 alpha 外框裁切，四周留 2px。
   4) 输出 RGBA PNG（filter 0，纯 zlib）。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- 极简 PNG 解码（8bit，colortype 2/6，非隔行） ---------- */
function decodePng(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG');
  let i = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('ascii');
    const data = buf.slice(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth);
  if (interlace) throw new Error('不支持隔行扫描');
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) throw new Error('只支持 colortype 2(RGB) / 6(RGBA)，实际 ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

/* ---------- PNG 编码（RGBA，filter 0） ---------- */
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                   // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 主流程 ---------- */
function cutout(img, WHITE = 236) {
  const { w, h, data } = img;
  const isWhite = (i) => data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE;

  // 从四边泛洪，只吃"与外界连通"的白
  const bg = new Uint8Array(w * h);
  const q = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (bg[p]) return;
    if (!isWhite(p * 4)) return;
    bg[p] = 1; q.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  for (let k = 0; k < q.length; k++) {
    const p = q[k], x = p % w, y = (p - x) / w;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }

  let removed = 0;
  for (let p = 0; p < w * h; p++) if (bg[p]) { data[p * 4 + 3] = 0; removed++; }

  // 只羽化"贴着透明区"的亮像素（描边抗锯齿留下的那圈浅灰）
  const edges = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (bg[p]) continue;
      let touch = false;
      if (x > 0 && bg[p - 1]) touch = true;
      else if (x < w - 1 && bg[p + 1]) touch = true;
      else if (y > 0 && bg[p - w]) touch = true;
      else if (y < h - 1 && bg[p + w]) touch = true;
      if (touch) edges.push(p);
    }
  }
  let softened = 0;
  for (const p of edges) {
    const i = p * 4;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum > 150) {                       // 越白越透明；深色描边（lum<150）保持不透明
      const a = Math.max(0, Math.round(255 * (255 - lum) / 105));
      if (a < data[i + 3]) { data[i + 3] = a; softened++; }
    }
  }

  // 裁到 alpha 外框
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('全透明了：白底阈值可能不对');
  const PAD = 2;
  x0 = Math.max(0, x0 - PAD); y0 = Math.max(0, y0 - PAD);
  x1 = Math.min(w - 1, x1 + PAD); y1 = Math.min(h - 1, y1 + PAD);
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  const out = Buffer.alloc(cw * chh * 4);
  for (let y = 0; y < chh; y++) {
    data.copy(out, y * cw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + cw) * 4);
  }
  return { w: cw, h: chh, data: out, removed, softened, box: { x0, y0, x1, y1 } };
}

/* ---------- 可以直接 require 复用（girl-profile.js 用同一套解码，别两处各写一份） ---------- */
module.exports = { decodePng, encodePng, cutout };

if (require.main === module) {
  const src = process.argv[2] || path.join(__dirname, '..', 'assets', 'girl-src.png');
  const dst = process.argv[3] || path.join(__dirname, '..', 'assets', 'girl.png');
  const img = decodePng(fs.readFileSync(src));
  console.log('读入 ' + src + '   ' + img.w + '×' + img.h);
  const r = cutout(img);
  const png = encodePng(r.w, r.h, r.data);
  fs.writeFileSync(dst, png);
  console.log('去白底 ' + r.removed + ' px，羽化边缘 ' + r.softened + ' px');
  console.log('裁切框 ' + JSON.stringify(r.box) + ' → ' + r.w + '×' + r.h);
  console.log('写出 ' + dst + '   ' + png.length + ' bytes');
  // 自检：角上必须是透明的（否则白底没去干净）
  let corner = 0;
  for (const p of [0, r.w - 1, (r.h - 1) * r.w, r.h * r.w - 1]) if (r.data[p * 4 + 3] === 0) corner++;
  console.log('自检：四角透明 ' + corner + '/4' + (corner === 4 ? ' ✅' : ' ⚠ 有角不透明'));

  // 深底预览：透明底图在白底查看器里看不出白边，必须叠到深色上才看得见
  const pv = Buffer.alloc(r.w * r.h * 4);
  for (let p = 0; p < r.w * r.h; p++) {
    const a = r.data[p * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const bgc = [38, 34, 28][c];                       // 面板深色
      pv[p * 4 + c] = Math.round(r.data[p * 4 + c] * a + bgc * (1 - a));
    }
    pv[p * 4 + 3] = 255;
  }
  const pvFile = path.join(__dirname, '..', 'shots', 'girl-preview.png');
  fs.mkdirSync(path.dirname(pvFile), { recursive: true });
  fs.writeFileSync(pvFile, encodePng(r.w, r.h, pv));
  console.log('深底预览 → ' + pvFile + '（看描边有没有留白边）');
}
