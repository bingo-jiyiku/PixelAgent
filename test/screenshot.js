// ============================================================
// test/screenshot.js —— 真开 Electron 窗口并截图（验收用）
// 跑法：npm run shot
// 会走真实的 main.js + 真实的 pi（PIXELAGENT_SHOT 是自动发的那句话）
// 出两张图：
//   shots/01-idle.png  刚进来的待机界面
//   shots/02-chat.png  pi 回完话之后的界面
// ============================================================
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

// 让主进程自动发一句话，这样截图里能看到真实的流式回复
process.env.PIXELAGENT_SHOT = process.env.SHOT_TEXT || '给我这台终端起个复古像素风的名字，八个字以内';

// 直接复用真实的主进程逻辑（建窗口、IPC、pi 桥全走生产代码）
require('../main.js');
const { getWindow } = require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function state() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return null;
  try {
    return await win.webContents.executeJavaScript(
      'window.__pixel ? {busy: !!window.__pixel.busy, round: window.__pixel.round, state: window.__pixel.lastState} : null'
    );
  } catch (e) { return null; }
}

async function shoot(name) {
  const win = getWindow();
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, img.toPNG());
  console.log('截图已保存:', file, fs.statSync(file).size, 'bytes');
  return file;
}

app.whenReady().then(async () => {
  // 等窗口 + 页面就绪
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }

  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(1500);              // 等字体和首屏渲染稳
  await shoot('01-idle.png');

  // 等自动发的那轮跑完（最多 90 秒）
  const deadline = Date.now() + 90000;
  let done = false;
  while (Date.now() < deadline) {
    const s = await state();
    if (s && s.round >= 1 && s.busy === false && (s.state === 'DONE')) { done = true; break; }
    await sleep(500);
  }
  await sleep(600);
  await shoot('02-chat.png');
  console.log(done ? '✅ 对话跑完后截图完成' : '⚠️ 等待对话结束超时，截的是当时的状态');
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
