/* ============================================================
   test/zoom-scene.js —— 把办公场景里每个元素单独放大截出来
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/zoom-scene.js

   为什么：整屏/整区域图在对话框里会被缩放，像素字体下「思考中…」「处理中…」
   根本分不清，我已经看串过一次。这里对每个元素：
     ① 用 getBoundingClientRect() 定位（不手填坐标）
     ② 按 dpr 换算后 capturePage 那一小块，放大 6 倍
     ③ **同时打印该块中心的实际像素值**（数值证据，眼睛和图像管线都不可靠时靠它）
   两个证据能对上，才算真的看清楚了。
   ============================================================ */
'use strict';

const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { decodePng } = require('../tools/make-girl');

process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// 每个状态要单独看清哪些元素
// 19:41 电脑加回来后：显示器/键盘/马克杯都在桌上
const WANT = {
  IDLE: ['.of-screen', '.of-keyboard', '.of-mug', '.of-shelf', '.of-plant'],
  THINKING: ['.of-bubble', '.of-screen', '.of-girl'],
  TOOL: ['.of-gear', '.of-screen', '.of-keyboard'],
  DONE: ['.of-stars', '.of-screen']
};

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  // 顶到最前，别让别的实例盖住（capturePage 可能截到别的窗口）
  win.show(); win.focus(); win.setAlwaysOnTop(true);
  if (typeof win.moveTop === 'function') win.moveTop();
  await sleep(2200);

  const js = (c) => win.webContents.executeJavaScript(c);
  const dpr = await js(`window.devicePixelRatio || 1`);

  for (const st of Object.keys(WANT)) {
    await js(`(function(){ document.getElementById('pixel-girl').dataset.state=${JSON.stringify(st)};
      document.getElementById('girl-scene').dataset.state=${JSON.stringify(st)}; return 1; })()`);
    await sleep(450);
    console.log(`\n== ${st} ==`);
    for (const sel of WANT[st]) {
      const r = await js(`(function(){
        const e=document.querySelector(${JSON.stringify(sel)});
        if(!e) return null;
        const b=e.getBoundingClientRect(); const cs=getComputedStyle(e);
        return {x:b.left,y:b.top,width:b.width,height:b.height,display:cs.display}; })()`);
      if (!r) { console.log(`  ⚠ ${sel} 不存在`); continue; }
      if (r.width < 1 || r.height < 1) { console.log(`  ⚠ ${sel} 尺寸为 0（display=${r.display}，可能当前状态不显示）`); continue; }
      // 余量要给够：齿轮的 4 颗齿是用 box-shadow 画在**盒子外面**的（各 7px），
      // pad 太小会把齿切掉 —— 切掉的齿看起来就像"齿轮没有齿"，又是一次假阴性。
      const P = 10;
      const rect = {
        x: Math.max(0, Math.round((r.x - P) * dpr)), y: Math.max(0, Math.round((r.y - P) * dpr)),
        width: Math.round((r.width + P * 2) * dpr), height: Math.round((r.height + P * 2) * dpr)
      };
      const img = await win.webContents.capturePage(rect);
      const raw = img.toPNG();
      let c = nativeImage.createFromBuffer(raw);
      const s = c.getSize();
      const Z = Math.max(2, Math.min(8, Math.round(360 / Math.max(1, s.width))));
      c = c.resize({ width: s.width * Z, height: s.height * Z, quality: 'best' });
      const name = `zz-${st}-${sel.replace(/[^a-z0-9]/gi, '')}.png`;
      fs.writeFileSync(path.join(OUT, name), c.toPNG());
      // 中心像素（数值证据）
      let px = '解码失败';
      try {
        const im = decodePng(raw);
        const cx = Math.round(im.w / 2), cy = Math.round(im.h / 2), i = (cy * im.w + cx) * 4;
        px = hex(im.data[i], im.data[i + 1], im.data[i + 2]) + ` alpha=${im.data[i + 3]}`;
      } catch (e) { /* ignore */ }
      console.log(`  ${sel.padEnd(14)} ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}  ×${Z} → ${name}  中心像素=${px}`);
    }
  }
  console.log('\n✅ 局部放大完成');
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
