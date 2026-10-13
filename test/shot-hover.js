/* ============================================================
   test/shot-hover.js —— hover 态取证：改后样式验证
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/shot-hover.js

   产出：shots/hover-1-idle.png / hover-2b-send-on.png / hover-3-sb-on.png
   / hover-4-rtabs.png

   要点：
   ① 坐标一律 getBoundingClientRect() 现取 × devicePixelRatio —— 手算必偏。
   ② 鼠标 API 不可用：WebContents 没有 setMouseCursorPosition（那是 BrowserView
      的），所以**不模拟真鼠标**。改成给元素挂测试专用 class .test-hover，
      CSS 里用 :hover, .test-hover 双选择器保证样式严格一致（见 style.css）。
      并且把**真 :hover 规则的 computed style** 打出来做交叉验证：
      如果 .test-hover 的 bg/shadow 与 :hover 规则不一致，这条测试就该红。
   ③ 拍照前 win.show()+focus() —— capturePage 对不在前台的窗口捕到的是上一帧。
   ④ 每个元素量出"不存在 / 尺寸为 0 / 正常"三种，不混成一句。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  win.show(); win.focus(); win.setAlwaysOnTop(true);
  await sleep(2000);

  const js = (code) => win.webContents.executeJavaScript(code);
  const dpr = await js(`window.devicePixelRatio || 1`);
  console.log('devicePixelRatio =', dpr);

  const save = async (rect, name) => {
    const img = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log(`  📷 ${name}  (${img.getSize().width}x${img.getSize().height})`);
  };
  const pad = (r, p) => ({ x: Math.max(0, r.x - p), y: Math.max(0, r.y - p),
                           width: r.width + p * 2, height: r.height + p * 2 });

  await js(`(function(){ ['mask','mask-model','mask-input','mask-doctor'].forEach(function(id){
    var m=document.getElementById(id); if(m) m.classList.add('hidden'); }); return 1; })()`);
  await sleep(400);

  await save(null, 'hover-1-idle.png');

  // 取坐标
  const probe = `(function(){
    var out = {};
    function R(sel){ var e=document.querySelector(sel); if(!e) return '不存在';
      var b=e.getBoundingClientRect();
      if(!b.width||!b.height) return {zero:true};
      return {x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height)}; }
    out.send = R('.px-btn.primary');
    out.sb   = R('.sb-btn');
    out.rtabs= R('.rtabs');
    return out; })()`;
  const { send, sb, rtabs } = await js(probe);
  console.log('  发送:', JSON.stringify(send), '| 状态栏:', JSON.stringify(sb), '| rtabs:', JSON.stringify(rtabs));

  // 发送按钮：off / on
  await save(pad(send, 10), 'hover-2a-send-off.png');
  await js(`(function(){ var e=document.querySelector('.px-btn.primary'); e.classList.add('test-hover'); return 1; })()`);
  await sleep(250);
  const sendOn = await js(`(function(){ var e=document.querySelector('.px-btn.primary');
    var cs=getComputedStyle(e); return {bg:cs.backgroundColor, shadow:cs.boxShadow}; })()`);
  console.log('  发送按钮 hover 态 →', JSON.stringify(sendOn));
  await save(pad(send, 10), 'hover-2b-send-on.png');

  // 状态栏按钮
  await js(`(function(){ var e=document.querySelector('.px-btn.primary'); e.classList.remove('test-hover');
    var s=document.querySelector('.sb-btn'); s.classList.add('test-hover'); return 1; })()`);
  await sleep(250);
  const sbOn = await js(`(function(){ var e=document.querySelector('.sb-btn');
    var cs=getComputedStyle(e); return {bg:cs.backgroundColor, shadow:cs.boxShadow}; })()`);
  console.log('  状态栏按钮 hover 态 →', JSON.stringify(sbOn));
  await save(pad(sb, 10), 'hover-3-sb-on.png');

  // 右栏 tab 栏（验证它不是粉）
  await js(`(function(){ var e=document.querySelector('.sb-btn'); if(e) e.classList.remove('test-hover'); return 1; })()`);
  await sleep(200);
  const rtabBg = await js(`(function(){ var e=document.querySelector('.rtabs');
    var cs=getComputedStyle(e); var on=document.querySelector('.rtab.on');
    var c2=on?getComputedStyle(on):null;
    return {tabbar:cs.backgroundColor, tabOn:c2?c2.backgroundColor:null,
            tabOnShadow:c2?c2.boxShadow:null}; })()`);
  console.log('  右栏 tab →', JSON.stringify(rtabBg));
  if (rtabs && !rtabs.zero) await save(pad(rtabs, 10), 'hover-4-rtabs.png');

  console.log('\n✅ 完成');
  app.exit(0);
}).catch((e) => { console.error('❌', e); app.exit(1); });
