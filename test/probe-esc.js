/* ============================================================
   test/probe-esc.js —— 一次性探针：设置面板开着时 Esc 为什么没关掉它
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/probe-esc.js

   现象：verify-features [8a-2]「设置面板开着时 Esc 能关掉面板」红了，
   但「Esc 关面板没有顺手中断」是绿的（中断计数 0→0）。
   这说明 Esc **没有掉到最终那行 `doAbort()`**，而是被**前面某一支**吃掉了、
   又没把设置面板关上。文档级 handler 的分支顺序是：
     mask-input → mask-model → mask-mcfg → mask(设置) → doAbort
   所以第一个问题不是"为什么没关"，而是"**哪一支接住了**"。
   ⇒ 本探针在 dispatch 之前把五个元素的真实 display 全打出来（不是猜），
     并把 window.onerror 也接上，免得"处理函数抛异常"被静默吞掉。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');

process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MASKS = ['mask', 'mask-model', 'mask-input', 'mask-mcfg'];

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });

  // 把渲染进程里的报错抓出来 —— 监听器里抛异常是**静默**的，
  // 不接这个就可能看到"什么都没发生"而找不到原因。
  win.webContents.on('console-message', (_e, level, message) => {
    if (/error|Error|Uncaught/.test(message)) console.log('  [渲染进程报错] ' + message);
  });

  await sleep(1800);
  const js = (code) => win.webContents.executeJavaScript(code);

  const dump = (tag) => js(`(function(){
    var probe = function(id){
      var e = document.getElementById(id);
      if (!e) return 'NOT_FOUND';
      return getComputedStyle(e).display === 'none' ? 'hidden' : 'VISIBLE';
    };
    var out = {};
    ${JSON.stringify(MASKS)}.forEach(function(id){ out[id] = probe(id); });
    out.aborts = window.__pixelAborts;
    out.focus = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'NONE';
    out.hasHandlerMark = typeof window.__pixelAborts;
    return out; })()`).then((o) => { console.log('  ' + tag + ': ' + JSON.stringify(o)); return o; });

  console.log('\n[0] 启动后的初始状态');
  await dump('初始');

  console.log('\n[1] 打开设置面板');
  await js(`document.getElementById('btn-settings').click()`);
  await sleep(1400);
  await dump('打开设置后');

  console.log('\n[2] 焦点移进面板（走中断分支的前提）');
  await js(`document.getElementById('set-cwd').focus()`);
  await sleep(150);
  await dump('聚焦后');

  console.log('\n[3] dispatch Escape');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(500);
  const after = await dump('Esc 之后');

  console.log('\n[4] 结论');
  console.log('  设置面板(#mask) = ' + after['mask']);
  console.log('  被谁接住了？看哪个浮层被关掉/或都不动：');
  MASKS.forEach((id) => console.log('    ' + id + ': ' + after[id]));
  console.log(after['mask'] === 'hidden'
    ? '  ✅ Esc 关掉了设置面板'
    : '  ❌ 设置面板没关 —— 需要看上面哪个浮层当时是 VISIBLE（就是它接住了 Esc）');

  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
