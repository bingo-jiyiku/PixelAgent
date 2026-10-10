// ============================================================
// shot-layouts.js —— 离屏渲染4个布局样稿并整页截图
// 用法：cd E:\PixelAgent && ./node_modules/.bin/electron variants/layout/shot-layouts.js
// ============================================================
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 关掉 GPU，避免离屏环境下 GPU 进程退出把整个 app 带走
app.disableHardwareAcceleration();

const VARIANTS = [
  ['L1', 'L1-video.html'],
  ['L2', 'L2-fullscreen.html'],
  ['L3', 'L3-deck.html'],
  ['L4', 'L4-twin.html']
];

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次只开一个窗口，逐个跑，避免离屏窗口互相干扰
async function shootOne(key, name) {
  const fp = path.join(__dirname, name);
  if (!fs.existsSync(fp)) { console.log(`⚠️ 缺文件 ${name}`); return; }

  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    show: false,
    webPreferences: { offscreen: true }
  });

  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  }).catch(() => {});

  try {
    await win.loadFile(fp);
  } catch (e) {
    console.log(`❌ ${name} 加载失败：${e.message}`);
    win.destroy();
    return;
  }

  // 等 did-finish-load + 字体渲染稳
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(900);

  try {
    const img = await win.webContents.capturePage();
    const out = path.join(OUT, `${key}.png`);
    fs.writeFileSync(out, img.toPNG());
    console.log(`✅ ${out}  (${img.toPNG().length} bytes)`);
  } catch (e) {
    console.log(`❌ ${name} 截图失败：${e.message}`);
  }
  win.destroy();
  await sleep(300);
}

(async () => {
  await app.whenReady();
  for (const [key, name] of VARIANTS) {
    await shootOne(key, name);
  }
  app.exit(0);
})();
