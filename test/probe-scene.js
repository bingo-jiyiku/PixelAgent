/* 探针：把四态下各特效元素的计算样式与盒子打出来（不猜，直接量） */
'use strict';
const { app } = require('electron');
const path = require('path');
process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res); else res();
  });
  await sleep(1800);
  const js = (c) => win.webContents.executeJavaScript(c);
  console.log('office 元素个数 =', await js(`document.querySelectorAll('.office').length`));
  console.log('girl-scene 元素个数 =', await js(`document.querySelectorAll('.girl-scene').length`));
  for (const st of ['IDLE', 'THINKING', 'TOOL', 'DONE']) {
    await js(`(function(){document.getElementById('pixel-girl').dataset.state=${JSON.stringify(st)};return 1})()`);
    await sleep(200);
    const out = await js(`(function(){
      const sel = {bubble:'.of-bubble', gear:'.of-gear', stars:'.of-stars', dots:'.of-dots', chair:'.of-chair'};
      const r = {};
      for (const k in sel) {
        const e = document.querySelector(sel[k]);
        if (!e) { r[k] = '不存在'; continue; }
        const cs = getComputedStyle(e), b = e.getBoundingClientRect();
        r[k] = cs.display + ' @' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height);
      }
      return r; })()`);
    console.log(st, JSON.stringify(out));
  }
  app.exit(0);
});
app.on('window-all-closed', () => app.exit(0));
