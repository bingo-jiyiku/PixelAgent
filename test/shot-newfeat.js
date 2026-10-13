/* 一次性截图：2026-10-13 新功能四件套的视觉效果（缓存命中 / 后台任务 / 欢迎预设 / 体检） */
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');
const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res); else res();
  });
  await sleep(2500);
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (n) => {
    // ★ capturePage 对不在前台的窗口会捕到**上一帧**（20 号图就这么拍到过工具页的旧帧，
    //   而 DOM 探针证明当时已经是智能体页）—— 拍之前先把窗口请到前台。
    try { win.show(); win.focus(); } catch (e) { /* ignore */ }
    await sleep(300);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, n), img.toPNG());
    console.log('  📷 ' + n);
  };

  // ① 缓存命中（喂一轮带缓存读的用量）+ 后台任务（喂两个在跑的任务）
  await js(`(function(){
    window.__pixelFeed({kind:'ev', ev:{type:'turn_end', message:{role:'assistant',
      usage:{input:1000, output:200, cacheRead:3000, cacheWrite:500, totalTokens:4700}, model:'m'}}});
    window.__pixelFeed({kind:'bg', tasks:[
      {id:'turn', kind:'turn', label:'帮我把 README 补完', state:'running', at:Date.now()},
      {id:'shell:9', kind:'shell', label:'npm test', state:'running', at:Date.now()-42000}
    ]});
    return 1; })()`);
  await js(`document.querySelector('.rtab[data-tab="sub"]').click()`);
  await sleep(600);
  await shot('20-cache-bg.png');

  // ② 欢迎页预设 + 体检报告
  await js(`document.getElementById('wl-overlay').classList.remove('hidden')`);
  await sleep(400);
  await shot('21-welcome-preset.png');
  await js(`document.getElementById('wl-doctor').click()`);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const st = await js(`window.__pixelDoctor && window.__pixelDoctor.open`);
    if (st) break;
  }
  await sleep(400);
  await shot('22-doctor.png');

  app.exit(0);
});
app.on('window-all-closed', () => app.exit(0));
