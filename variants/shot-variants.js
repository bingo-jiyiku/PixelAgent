// ============================================================
// variants/shot-variants.js —— 给三个变体各出一张真实截图
// 跑法：cd E:\PixelAgent && ./node_modules/.bin/electron variants/shot-variants.js
// 出图：variants/shots/A.png / B.png / C.png
// ============================================================
'use strict';

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const W = 1360;

const targets = [
  ['A-深墨终端.html', 'A.png'],
  ['B-纸张档案.html', 'B.png'],
  ['C-混合机柜.html', 'C.png']
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读 PNG 头部 16..24 字节拿宽高，验证截图没被屏幕尺寸裁掉
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  // 离屏渲染：不受屏幕高度限制，整页都能截
  const useOffscreen = true;
  console.log('工作区:', wa.width + 'x' + wa.height, '离屏:', useOffscreen);

  const win = new BrowserWindow({
    width: W,
    height: 1000,
    x: 0,
    y: 0,
    show: !useOffscreen,
    frame: false,
    useContentSize: true,
    backgroundColor: '#14171c',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: useOffscreen
    }
  });
  console.log('离屏渲染:', useOffscreen);

  await sleep(400);

  for (const [file, out] of targets) {
    const target = path.join(OUT, out);
    try {
      await win.loadFile(path.join(__dirname, file));
      await win.webContents.executeJavaScript('document.fonts.ready.then(function(){return 1;})');
      await sleep(500);
      // 先把窗口压小，避免上一次的高度把这次的 scrollHeight 撑大
      win.setContentSize(W, 600);
      await sleep(250);
      // 再量页面真实高度，按这个高度重设窗口，最后整页截
      const h = await win.webContents.executeJavaScript(
        'Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))'
      );
      win.setContentSize(W, h);
      await sleep(500);
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: h });
      const png = img.toPNG();
      fs.writeFileSync(target, png);
      const s = pngSize(target);
      console.log('✅', out, s.w + 'x' + s.h, s.bytes + ' bytes', '(页面高 ' + h + ')');
    } catch (e) {
      console.log('❌', file, e && e.message);
    }
  }

  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
