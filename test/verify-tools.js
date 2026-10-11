// test/verify-tools.js —— 用「真实抓下来的 pi 事件流」回放，验收右栏 TOOLS 面板
// 为什么要这样测：靠真实调用 pi 触发工具不可控（它可能直接回答不调工具），
// 靠读代码判断形状更是自欺欺人。这里喂的是 pi 真实吐出的原始 NDJSON，
// 走的是 renderer 里生产代码的 onMsg，所以验的是真行为。
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const FIX = path.join(__dirname, 'fixtures', 'pi-events.ndjson');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(1500);

  const evs = fs.readFileSync(FIX, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log('夹具事件', evs.length, '条，开始回放…');

  let n = -1;
  try {
    n = await win.webContents.executeJavaScript(
      `(function(evs){ if (typeof window.__pixelFeed !== 'function') return -1;` +
      ` evs.forEach(function(e){ window.__pixelFeed({kind:'ev', ev:e}); });` +
      ` return window.__pixel.tools.length; })(${JSON.stringify(evs)})`);
  } catch (e) {
    console.log('❌ 回放注入失败:', e && e.message ? e.message : e);
    app.exit(1);
    return;
  }
  console.log('喂入真实事件 → TOOLS 记录', n, '条');

  await win.webContents.executeJavaScript(
    `document.querySelector('.rtab[data-tab="tools"]').click()`);
  await sleep(700);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, '08-tools-live.png'), img.toPNG());
  console.log('截图已保存: shots/08-tools-live.png');

  // 展开工具卡片，确认完整入参 / 输出真的渲染出来了
  // （这条断言是有来历的：tool_execution_end 事件里根本没有 args 字段，
  //   早先从它取 args 会渲染成空对象 { }，只有真跑回放才看得出来）
  const opened = await win.webContents.executeJavaScript(
    `(function(){var h=document.querySelector('#tools-list .t-head'); if(!h) return 'NO_HEAD'; h.click();
      var b=document.querySelector('#tools-list .t-body'); if(!b) return 'NO_BODY';
      var pres=b.querySelectorAll('pre');
      return (b.classList.contains('hidden')?'STILL_HIDDEN':'OPENED') + '|pre=' + pres.length +
             '|IN=' + (pres[0] ? pres[0].textContent.replace(/\\s+/g,' ').slice(0,60) : '') +
             '|OUT=' + (pres[1] ? pres[1].textContent.replace(/\\s+/g,' ').slice(0,50) : '');})()`);
  console.log('工具卡片展开:', opened);
  await sleep(400);
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, '10-tool-open.png'), img2.toPNG());
  console.log('截图已保存: shots/10-tool-open.png');

  const okOpen = opened.indexOf('OPENED') === 0 && opened.indexOf('command') >= 0;
  console.log(okOpen ? '✅ 展开后入参完整（含 command）' : '❌ 展开后入参为空');
  console.log(n > 0 ? '✅ TOOLS 面板被真实事件填上了' : '❌ TOOLS 面板仍是空的');
  app.exit((n > 0 && okOpen) ? 0 : 1);
});
app.on('window-all-closed', () => app.exit(0));
