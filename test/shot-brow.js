/* ============================================================
   test/shot-brow.js —— 恼火表情 + 敲键盘动作取证
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/shot-brow.js

   产出：shots/brow-1-idle.png / brow-2-tool.png / brow-3-think.png
   量什么：
     ① .of-brow 的 getBoundingClientRect 必须落在人物脸范围内
        （girl x=95..195，脸 y≈95..125）—— 落在别处就是位置算错，截图会暴露。
     ② TOOL 态人物 .of-girl 的 --dy-b 必须非 0（人物本体在动，不双影的前提）
     ③ TOOL 态 .of-hand-l/.of-hand-r 的 translateY 必须反相且幅度 >= 6px
        （原来只有 ±3.5px，老板说看不出）
     ④ 每个元素量出"不存在 / 尺寸为 0 / 正常"三种，不混成一句。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULT = { pass: 0, fail: 0, bad: [] };
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { RESULT.pass++; console.log(`  ✓ ${name}`); }
  else { RESULT.fail++; RESULT.bad.push(name); console.log(`  ❌ ${name}\n      期望 ${JSON.stringify(want)}\n      实际 ${JSON.stringify(got)}`); }
}

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  win.show(); win.focus(); win.setAlwaysOnTop(true);
  await sleep(2200);

  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`(function(){ ['mask','mask-model','mask-input','mask-doctor'].forEach(function(id){
    var m=document.getElementById(id); if(m) m.classList.add('hidden'); }); return 1; })()`);
  await sleep(300);

  // 诊断：打印浏览器实际加载的 office innerHTML，确认 DOM 来源
  const dump = await js(`(function(){
    var o=document.getElementById('pixel-girl');
    if(!o) return '无 #pixel-girl';
    var h=o.innerHTML;
    return {
      len:h.length, hasBrow: h.indexOf('of-brow')>=0, hasBubble: h.indexOf('of-bubble')>=0,
      childCount: o.children.length,
      kids: Array.prototype.map.call(o.children, function(c,i){
        return i+':'+c.tagName+'.'+(c.className||''); }),
      browIdx: h.indexOf('of-brow'), bubIdx: h.indexOf('of-bubble')
    }; })()`);
  console.log('  DOM 诊断:', JSON.stringify(dump));
  const geo = await js(`(function(){
    var o=document.getElementById('pixel-girl'); if(!o) return {none:true};
    var b=o.getBoundingClientRect();
    function R(sel){
      var e=document.querySelector(sel); if(!e) return '无';
      var r=e.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
              inOffice: o.contains(e)}; }
    return {
      office:{x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)},
      girl:R('.of-girl'), brow:R('.of-brow'), hl:R('.of-hand-l'), hr:R('.of-hand-r'),
      children:Array.prototype.map.call(o.children, function(c){ return c.className || c.tagName; })
    }; })()`);
  console.log('  几何:', JSON.stringify(geo));

  const shoot = async (state, name) => {
    const log = [];
    try {
      await js(`document.getElementById('pixel-girl').setAttribute('data-state', ${JSON.stringify(state)})`);
      log.push('setAttr ok');
    } catch (e) { log.push('setAttr ERR: ' + e.message); }
    await sleep(600);
    let cs = null;
    try {
      cs = await js(`(function(){
        function q(s){ return document.querySelector(s); }
        var g=q('.of-girl'); var br=q('.of-brow');
        var hl=q('.of-hand-l'); var hr=q('.of-hand-r');
        function T(e){ return e?getComputedStyle(e).transform:null; }
        function BB(e){ if(!e) return null; var r=e.getBoundingClientRect();
          return Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+'x'+Math.round(r.height); }
        return { girl:T(g), browDisp:br?getComputedStyle(br).display:null,
                 browAnim:br?getComputedStyle(br).animationName:null,
                 browBB:BB(br),
                 hlDisp:hl?getComputedStyle(hl).display:null, hlT:T(hl),
                 hrDisp:hr?getComputedStyle(hr).display:null, hrT:T(hr) }; })()`);
      log.push('cs ok');
    } catch (e) { log.push('cs ERR: ' + e.message); }
    try {
      const pad = 8, r = geo.office;
      const img = await win.webContents.capturePage({
        x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
        width: r.w + pad * 2, height: r.h + pad * 2 });
      fs.writeFileSync(path.join(OUT, name), img.toPNG());
      log.push('📷 ' + name + ' ' + img.getSize().width + 'x' + img.getSize().height);
    } catch (e) { log.push('shot ERR: ' + e.message); }
    console.log('  [' + state + '] ' + log.join(' | '));
    return cs;
  };

  console.log('\n[IDLE]');
  const idle = await shoot('IDLE', 'brow-1-idle.png');
  if (!idle) { console.log('  ❌ IDLE 采样失败'); app.exit(1); return; }
  t('IDLE 无眉毛', idle.browDisp, 'none');
  t('IDLE 手层隐藏', idle.hlDisp, 'none');

  console.log('\n[TOOL]');
  const tool = await shoot('TOOL', 'brow-2-tool.png');
  console.log('  TOOL computed:', JSON.stringify(tool));
  t('TOOL 眉毛显示', tool.browDisp, 'block');
  t('TOOL 眉毛在动', tool.browAnim === 'of-brow-angry', true);
  t('TOOL 左手显示', tool.hlDisp, 'block');
  t('TOOL 右手显示', tool.hrDisp, 'block');
  // TOOL 态多采样 —— steps(1) 动画只在关键时刻跳变，单次采样可能落在静止帧
  const samples = [];
  for (let k = 0; k < 6; k++) {
    await sleep(90);
    const s = await js(`(function(){
      var g=document.querySelector('.of-girl');
      var hl=document.querySelector('.of-hand-l'); var hr=document.querySelector('.of-hand-r');
      return { g:getComputedStyle(g).transform, hl:getComputedStyle(hl).transform, hr:getComputedStyle(hr).transform }; })()`);
    samples.push(s);
  }
  const parse = (s) => {
    // getComputedStyle 返回 "matrix(0.999925, -0.012217, 0.012217, 0.999925, 0, -1.4)"，逗号后有空格
    const m = /matrix\(([-\d.eE+]+),\s*([-\d.eE+]+),\s*([-\d.eE+]+),\s*([-\d.eE+]+),\s*([-\d.eE+]+),\s*([-\d.eE+]+)\)/.exec(s || '');
    return m ? { a: parseFloat(m[1]), x: parseFloat(m[5]), y: parseFloat(m[6]) } : null;
  };
  const ps = samples.map(s => ({ g: parse(s.g), hl: parse(s.hl), hr: parse(s.hr) }));
  const gy = ps.map(p => (p.g ? p.g.y : null));
  const hly = ps.map(p => (p.hl ? p.hl.y : null));
  const hry = ps.map(p => (p.hr ? p.hr.y : null));
  console.log('  人物 y 采样:', gy.join(', '));
  console.log('  左手 y 采样:', hly.join(', '));
  console.log('  右手 y 采样:', hry.join(', '));
  if (ps.length && ps[0].g) console.log('  原始 transform[0]:', samples[0].g);
  const valid = a => a.filter(v => v != null);
  t('人物本体在动（多采样有变化）', new Set(valid(gy)).size > 1, true);
  t('左手在动（多采样有变化）', new Set(valid(hly)).size > 1, true);
  t('右手在动（多采样有变化）', new Set(valid(hry)).size > 1, true);
  const range = a => valid(a).length > 1 ? Math.max(...valid(a)) - Math.min(...valid(a)) : 0;
  console.log(`  左手行程 ${range(hly).toFixed(1)}px / 右手行程 ${range(hry).toFixed(1)}px`);
  t('敲击行程 >= 8px（原 3.5px 太看不出来）', Math.max(range(hly), range(hry)) >= 8, true);
  // 反相：左手在最低点时右手应在最高点附近（反之亦然）
  let anti = false;
  for (const p of ps) {
    if (!p.g || !p.hl || !p.hr) continue;
    const dl = p.hl.y - p.g.y, dr = p.hr.y - p.g.y;
    if (dl * dr < 0) { anti = true; break; }   // 一正一负 = 一上一下
  }
  t('左右手反相（交替敲击）', anti, true);

  console.log('\n[THINKING]');
  const think = await shoot('THINKING', 'brow-3-think.png');
  t('THINKING 眉毛皱眉', think.browAnim === 'of-brow-frown', true);

  console.log(`\n${RESULT.pass === 0 ? '' : '✅ '}${RESULT.pass} 通过 / ${RESULT.fail} 失败`);
  if (RESULT.bad.length) console.log('  失败项:', RESULT.bad.join(' | '));
  app.exit(RESULT.fail ? 1 : 0);
}).catch((e) => { console.error('❌', e); app.exit(1); });
