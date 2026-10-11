/* ============================================================
   test/probe-mcfg.js —— 一次性探针：模型「配置」保存到底卡在哪
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/probe-mcfg.js

   起因：verify-features [10] 里「覆盖值写进了配置文件」是红的，而
   「清空后覆盖值从配置里删掉了」却绿 —— 后者在"从来没写进去过"时也恒绿。
   配置文件里躺着一个 `modelOverrides: {}`。
   "保存没生效"至少有四种完全不同的原因，只看最终文件分不出来：
     ① 值没进输入框（`#mcfg-ctx.value` 还是空）
     ② 值进了，但 `MCFG.sel` 已经被清掉（对话框被人关了）→ saveModelConfig 直接 return
     ③ 值进了，主进程收到但被白名单过滤掉（`droppedKeys` 非空）
     ④ 都对了，只是**慢**（我读文件的时刻还没落盘）
   所以本探针把这四个量**同时**打出来，而不是猜一个。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG_FILE = path.join(__dirname, '..', '.pixelagent.json');

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(1800);

  const js = (code) => win.webContents.executeJavaScript(code);
  const readFile = () => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) { return { ERR: e.message }; } };
  const dump = (tag) => Promise.all([
    js(`(function(){ var e=document.getElementById('mcfg-ctx'); return e ? e.value : 'NOT_FOUND'; })()`),
    js(`window.__pixelMcfg()`),
    js(`(function(){ var e=document.getElementById('mcfg-note'); return e ? e.textContent : 'NOT_FOUND'; })()`),
    js(`(function(){ var e=document.getElementById('mask-mcfg'); return e ? getComputedStyle(e).display : 'NOT_FOUND'; })()`),
    js(`JSON.stringify((window.__pixelCfg()||{}).modelOverrides || {})`)
  ]).then(([ctxVal, mcfg, note, maskDisp, uiOv]) => {
    console.log('\n---- ' + tag + ' ----');
    console.log('  #mcfg-ctx.value      = ' + JSON.stringify(ctxVal));
    console.log('  __pixelMcfg()        = ' + JSON.stringify(mcfg));
    console.log('  #mcfg-note           = ' + JSON.stringify(note));
    console.log('  #mask-mcfg display   = ' + maskDisp);
    console.log('  渲染层 CFG.modelOverrides = ' + uiOv);
    console.log('  磁盘 .pixelagent.json 里   = ' + JSON.stringify(readFile().modelOverrides));
  });

  console.log('\n[1] 打开模型框');
  await js(`document.getElementById('btn-model').click()`);
  await sleep(2600);
  await js(`(function(){ var q=document.getElementById('mdl-q'); q.value=''; q.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(400);

  // ★ 目标模型必须在**列表已渲染之后**取。
  //   第一版我在打开模型框之前就取了 `curModel || piDefault` —— 那时 piDefault 还是
  //   null（启动时的 --list-models 没跑完），于是拿空名字去查行，得到 NO_ROW，
  //   探针"什么都没验到"却看起来像产品坏了。
  const TARGET = await js(`(function(){
    var p = window.__pixel;
    var want = p.curModel || p.piDefault || null;
    var rows = [].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
    var names = rows.map(function(r){ return r.querySelector('.mi-n').textContent.trim(); });
    var pick = (want && want.model && names.indexOf(want.model) >= 0) ? want.model
             : (names.length ? names[names.length - 1] : '');
    var hit = (p.models || []).filter(function(m){ return m.model === pick; })[0] || {};
    return { provider: hit.provider || null, model: pick, how: (want && want.model === pick) ? 'curModel/piDefault' : '列表兜底',
             total: names.length, curModel: p.curModel, piDefault: p.piDefault };
  })()`);
  console.log('目标模型 = ' + JSON.stringify(TARGET));

  console.log('[2] 打开该行的配置（mdl-config 按钮已删，用 window.__openModelConfig）');
  const clicked = await js(`(function(){
    var rows = [].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
    var row = rows.filter(function(r){ var n = r.querySelector('.mi-n');
      return n && n.textContent.trim() === ${JSON.stringify(String(TARGET.model))}; })[0];
    if (!row) return 'NO_ROW';
    row.click();
    if (!window.__openModelConfig) return 'NO_CFG_FN';
    var em = window.__effModel ? window.__effModel() : null;
    if (!em || !em.model) return 'NO_EFF_MODEL';
    var models = window.__models ? window.__models() : [];
    var hit = models.find(function(m){ return m.model === em.model && (!em.provider || m.provider === em.provider); })
            || models.find(function(m){ return m.model === em.model; });
    if (!hit) return 'NO_HIT';
    window.__openModelConfig(hit, false);
    return 'OK'; })()`);
  console.log('  点击结果 = ' + clicked);
  await sleep(1500);
  await dump('打开配置框之后');

  console.log('\n[3] 往 #mcfg-ctx 写 300000，并**回读**');
  await js(`(function(){ var i=document.getElementById('mcfg-ctx'); i.value='300000';
    i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(200);
  await dump('写入之后（保存之前）');

  console.log('\n[4] 点保存，然后每 300ms 看一次，最多 6 秒');
  await js(`document.getElementById('mcfg-save').click()`);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const ov = readFile().modelOverrides || {};
    const has = Object.keys(ov).length > 0;
    if (has) {
      console.log('  ✅ 第 ' + ((i + 1) * 0.3).toFixed(1) + ' 秒终于落盘了：' + JSON.stringify(ov));
      break;
    }
    if (i === 19) console.log('  ❌ 6 秒内一直没有落盘');
  }
  await dump('保存之后');

  console.log('\n[5] 收尾：把覆盖值清干净（不留痕）');
  await js(`(function(){ var i=document.getElementById('mcfg-ctx'); if(i) i.value=''; return 1; })()`);
  await js(`document.getElementById('mcfg-save').click()`);
  await sleep(1200);
  console.log('  清理后磁盘 = ' + JSON.stringify(readFile().modelOverrides));

  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
