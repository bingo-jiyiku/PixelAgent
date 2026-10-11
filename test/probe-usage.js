/* 一次性诊断：看用量条 / 模型目录里到底显示的是哪几个数字。
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/probe-usage.js */
'use strict';
const { app } = require('electron');
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
  await sleep(2500);
  const js = (c) => win.webContents.executeJavaScript(c);

  // 等模型目录到位（用量条的分母靠它）
  for (let i = 0; i < 40; i++) {
    const n = await js(`document.querySelectorAll('#mdl-list .mdl-item').length`);
    if (n > 0) break;
    await js(`document.getElementById('btn-model').click()`);
    await sleep(500);
  }
  await js(`(function(){ var b=document.getElementById('mdl-x'); if(b) b.click(); return 1; })()`);
  await sleep(400);

  const info = await js(`(function(){
    var txt = document.getElementById('ub-text');
    var sb = document.getElementById('sb-usage');
    return {
      ubText: txt ? txt.textContent : 'NO_EL',
      sbTitle: sb ? sb.title : 'NO_EL',
      modelBar: (document.getElementById('sb-model')||{}).textContent,
      kvModel: (document.getElementById('kv-model')||{}).textContent,
      curModel: window.__pixelCfg ? 'n/a' : 'n/a'
    }; })()`);
  console.log('== 界面上的上下文相关显示 ==');
  console.log(JSON.stringify(info, null, 2));

  const models = await js(`(function(){
    return (window.__pixelModels || null); })()`);
  // 直接从主进程拿目录，绕开渲染层
  const r = await js(`window.pixelAPI.models()`);
  const list = (r && r.models) || [];
  console.log('\n== pi 目录里所有 context 取值（原始串）==');
  const byCtx = {};
  list.forEach((m) => { byCtx[m.context] = (byCtx[m.context] || 0) + 1; });
  console.log(JSON.stringify(byCtx));
  console.log('当前模型 = ' + JSON.stringify(r && r.current));
  const cur = r && r.current && r.current.model;
  if (cur) {
    const hit = list.find((m) => m.model === cur.model);
    console.log('命中目录 = ' + JSON.stringify(hit));
    console.log('→ 用量条会显示分母 = ' + (hit ? hit.contextTokens : 0) +
      '（原始串 "' + (hit ? hit.context : '?') + '"）');
  }
  app.exit(0);
});
app.on('window-all-closed', () => app.exit(0));
