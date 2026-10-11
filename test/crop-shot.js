/* ============================================================
   test/crop-shot.js —— 把验收截图裁一块放大，用来肉眼核对细节
   ------------------------------------------------------------
   跑法：
     electron test/crop-shot.js <in.png> <out.png> <x> <y> <w> <h> [scale]

   为什么值得留一个工具：
   1340×880 的整屏截图在对话框里看，字都是糊的 —— 会话条上
   "改名/导出/删除"和标题**叠在一起**这件事，看整图根本发现不了，
   放大 3 倍一眼就看见了。功能断言也测不到它（DOM 结构完全正确），
   只有量几何或者放大看才看得见。
   ============================================================ */
'use strict';

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 6) {
  console.log('用法: electron test/crop-shot.js <in.png> <out.png> <x> <y> <w> <h> [scale]');
  app.exit(2);
} else {
  app.whenReady().then(() => {
    const [src, out, x, y, w, h, scale] = args;
    const img = nativeImage.createFromPath(path.resolve(src));
    console.log('原图尺寸:', JSON.stringify(img.getSize()));
    let c = img.crop({ x: Number(x), y: Number(y), width: Number(w), height: Number(h) });
    const s = Number(scale || 2);
    if (s !== 1) {
      const cs = c.getSize();
      c = c.resize({ width: Math.round(cs.width * s), height: Math.round(cs.height * s), quality: 'best' });
    }
    fs.writeFileSync(path.resolve(out), c.toPNG());
    console.log('已写出:', out, JSON.stringify(c.getSize()));
    app.exit(0);
  });
}
