/* ============================================================
   test/zoom-parts.js —— 按 DOM 选择器自动定位并放大截图
   ------------------------------------------------------------
   跑法：electron test/zoom-parts.js

   为什么要有它：
   crop-shot.js 要求你**手填 x/y/w/h**，而整屏 1340×880 的图在对话框里
   是缩过的，手算坐标会来回试错（我就试了 4 次全打偏）。
   这里改成先问 DOM 要 getBoundingClientRect()，再用
   webContents.capturePage(rect) 直接截那块 —— 坐标永远对得上。

   用法（改下面的 PARTS 即可）：
   { sel: 选择器, name: 输出名, scale: 放大倍数, pad: 外扩像素 }
   ============================================================ */
'use strict';

const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只挑"中文改完之后最需要在像素字体回退下肉眼复核"的那几块
const PARTS = [
  { sel: '.m.bot .m-tools', name: 'zz-msgbar.png', scale: 6, pad: 6 },
  { sel: '.m.user .who', name: 'zz-who-user.png', scale: 8, pad: 8 },
  { sel: '.m.step .who', name: 'zz-who-sys.png', scale: 8, pad: 8 },
  { sel: '.m.shell .sh-code.bad', name: 'zz-shellcode.png', scale: 8, pad: 8 },
  { sel: '.m.shell .who', name: 'zz-who-shell.png', scale: 8, pad: 8 },
  { sel: '#sb-state', name: 'zz-sbtag.png', scale: 8, pad: 8 },
  { sel: '.rtab[data-tab="sub"]', name: 'zz-tab.png', scale: 8, pad: 8 },
  { sel: '#tools-list .t-k', name: 'zz-tool-k.png', scale: 8, pad: 8 },
  { sel: '#tools-list .tool-item', name: 'zz-tool.png', scale: 4, pad: 6 },
  { sel: '.rail-right .ag-tag', name: 'zz-agtag.png', scale: 8, pad: 8 },
  { sel: '.sb-vis b', name: 'zz-vis.png', scale: 8, pad: 8 },
  { sel: '.kv span', name: 'zz-kvlabel.png', scale: 8, pad: 6 }
];

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
  const shot = async (rect, name, scale) => {
    const img = await win.webContents.capturePage(rect);
    let c = nativeImage.createFromBuffer(img.toPNG());
    const s = c.getSize();
    if (scale !== 1) c = c.resize({ width: Math.round(s.width * scale), height: Math.round(s.height * scale), quality: 'best' });
    fs.writeFileSync(path.join(OUT, name), c.toPNG());
    console.log('  📷 ' + name + '  ' + JSON.stringify(c.getSize()));
  };

  // 先让时间线里有内容（点第二个会话回放历史）
  await js(`(function(){var s=document.querySelectorAll('#session-list .sess'); if(s[1]) s[1].click(); return 1;})()`);
  await sleep(1500);

  // 喂一条真实结构的工具事件 → 右栏 TOOLS 出现一条（含「入参 / 返回」两个小标题）
  await js(`(function(){
    window.__pixelFeed({kind:'ev', ev:{type:'tool_execution_start', toolCallId:'zz1', toolName:'read', args:{path:'README.md'}}});
    window.__pixelFeed({kind:'ev', ev:{type:'tool_execution_end', toolCallId:'zz1', toolName:'read',
      arguments:{path:'README.md'}, result:{output:'# PixelAgent'}}});
    return true; })()`);
  await sleep(400);

  // 真跑一条失败命令 → 拿到「失败」退出码徽章（这段走真 shell，不是假数据）
  await js(`(function(){ const i=document.getElementById('input'); i.value='!exit 3'; send(); return true; })()`);
  await sleep(2600);

  // 工具面板是隐藏 tab 的话 getBoundingClientRect 全是 0 —— 先切过去
  await js(`(function(){ const t=document.querySelector('.rtab[data-tab="tools"]'); if(t) t.click(); return 1; })()`);
  await sleep(500);

  for (const p of PARTS) {
    const r = await js(`(function(){
      const el = document.querySelector(${JSON.stringify(p.sel)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height, t: (el.textContent || '').trim().slice(0, 40) };
    })()`);
    if (!r || !r.width || !r.height) { console.log('  ⚠ 找不到 / 零尺寸: ' + p.sel); continue; }
    const P = p.pad || 0;
    const scale = await js(`window.devicePixelRatio || 1`);
    const rect = {
      x: Math.max(0, Math.round((r.x - P) * scale)),
      y: Math.max(0, Math.round((r.y - P) * scale)),
      width: Math.round((r.width + P * 2) * scale),
      height: Math.round((r.height + P * 2) * scale)
    };
    console.log('  ℹ ' + p.sel + ' → ' + JSON.stringify(rect) + '  文字=' + JSON.stringify(r.t));
    await shot(rect, p.name, p.scale || 4);
  }

  console.log('✅ 局部放大完成');
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
