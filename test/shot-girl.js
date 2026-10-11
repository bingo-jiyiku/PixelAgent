/* ============================================================
   test/shot-girl.js —— 欢迎区吉祥物四态截图 + 排版量测
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/shot-girl.js

   为什么要它：
   办公场景是**纯几何对齐**（人物 left/bottom/width、桌子 height、显示器 bottom），
   必须看图才能确认「桌面真的挡住下半身、显示器不压脸、键盘在人物手前」。
   顺便把关键盒子的 getBoundingClientRect 打出来，把"相交/不相交"变成数字。

   ★★ 两个必须记住的坑（本脚本就是被它们咬过才写成这样的）★★

   【坑一】`capturePage` 可能给你**别的窗口的画面**。
   实测：对话框（另一个正在跑的 PixelAgent 实例）盖住了目标区域，
   四张截图里有两张 md5 完全相同 —— 静态画面才会字节一致，
   而我自己那张是带动画的，**字节相同就是铁证：截到的是别人的静态画面**。
   对策：① 截图前 win.show()+focus()+setAlwaysOnTop(true)+moveTop()；
        ② 每张图都做**像素自检**（见 checkBorder），不过就报 ❌ 而不是默默写文件。
   —— "截图成功"和"截到了要截的东西"是两件事，输出里必须能分开说。

   【坑二】别靠"看图"分辨 THINKING / TOOL。
   像素字体下「思考中…」「处理中…」几乎分不清，我因此把两张图看串过一次。
   对策：拍照前把当时各特效的 computedStyle 一起打出来（下面 now 那段），
        **日志与图必须能互相对上**。
   ============================================================ */
'use strict';

const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { decodePng } = require('../tools/make-girl');   // 复用同一套 PNG 解码，不另写一份

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息 → 停在欢迎页
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATES = ['IDLE', 'THINKING', 'TOOL', 'DONE'];

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });

  // ★ 坑一对策①：把自己的窗口顶到最前面，别让别的实例盖住
  win.show(); win.focus(); win.setAlwaysOnTop(true);
  if (typeof win.moveTop === 'function') win.moveTop();
  await sleep(2000);

  const js = (code) => win.webContents.executeJavaScript(code);
  const dpr = await js(`window.devicePixelRatio || 1`);
  console.log('devicePixelRatio =', dpr);

  /* ---------- 0. 视野体检：有对话框盖着就先关掉 ---------- */
  const view = await js(`(function(){
    const m = document.getElementById('mask');
    const w = document.getElementById('welcome');
    const r = w ? w.getBoundingClientRect() : null;
    return { maskHidden: !m || m.classList.contains('hidden'),
             welcome: r ? Math.round(r.width) + 'x' + Math.round(r.height) : '不存在' };
  })()`);
  console.log('视野体检：遮罩隐藏=' + view.maskHidden + '  欢迎区=' + view.welcome);
  if (!view.maskHidden) {
    await js(`(function(){ const b=document.getElementById('dlg-x')||document.getElementById('mdl-x');
      if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 1; })()`);
    await sleep(400);
    const again = await js(`document.getElementById('mask').classList.contains('hidden')`);
    console.log(again ? '  ✅ 已关掉遮罩' : '  ⚠ 遮罩还在，下面的自检会报错');
  }

  /* ---------- 1. 排版量测 ---------- */
  const geo = await js(`(function(){
    const pick = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
               bottom: Math.round(b.bottom), right: Math.round(b.right) }; };
    // 19:41 电脑加回来，显示器重新量测
    return { scene: pick('#girl-scene'), office: pick('#pixel-girl'), girl: pick('.of-girl'),
             desk: pick('.of-desk'), mon: pick('.of-monitor'), scr: pick('.of-screen'),
             kb: pick('.of-keyboard'), mug: pick('.of-mug') };
  })()`);
  console.log('\n== 几何量测 ==');
  for (const [k, v] of Object.entries(geo || {})) {
    if (!v) { console.log(`  ⚠ ${k}: 元素不存在`); continue; }
    console.log(`  ${k.padEnd(7)} x=${v.x} y=${v.y} w=${v.w} h=${v.h} right=${v.right} bottom=${v.bottom}`);
  }
  const g = geo && geo.girl, d = geo && geo.desk, m = geo && geo.mon;
  if (g && d) {
    const ov = Math.min(g.bottom, d.bottom) - Math.max(g.y, d.y);
    console.log(`  ▪ 人物×桌子 垂直重叠 = ${ov}px  ${ov > 8 ? '✅ 桌面挡住下半身（读成坐姿）' : '❌ 重叠太少 → 还是站姿'}`);
  }
  // 露出上半身高度：桌面顶 y 减去人物顶 y（老板 2026-10-11："要看到上半身"）
  if (g && d) {
    const deskTop = d.y;   // 桌顶 y 值
    const shown = deskTop - g.y;
    console.log(`  ▪ 露出上半身 = ${shown}px  ${shown >= 100 ? '✅ 露出充分（>=100px）' : '⚠ 露出偏少（<100px）'}`);
  }
  // 显示器不压脸：显示器右边和人物左边的水平重叠 < 40px
  if (g && m) {
    const ho = Math.min(g.right, m.right) - Math.max(g.x, m.x);
    console.log(`  ▪ 显示器×人物 水平重叠 = ${ho}px  ${ho < 40 ? '✅ 不压脸' : '⚠ 显示器压到人物了'}`);
  }

  /* ---------- 2. 截图 + 像素自检 ---------- */
  // 自检：办公场景顶边应该是墙面颜色，被别的窗口盖住时这一行会花 → 直接判 ❌。
  // ★ 2026-10-11 20:30：墙面从"奶油色网格"改成"白色 + 淡横线条纹"（老板要"白色标签感"）
  //   新墙面主色 #ffffff（白）+ #e4e4e0（浅灰线）→ 检查 R>200 && G>200 && B>180。
  //   旧的"排除纯白"逻辑不再适用（现在纯白就是主色）。
  function checkBorder(pngBuf) {
    try {
      const im = decodePng(pngBuf);
      let wall = 0, tot = 0;
      // 裁剪图里场景顶边在 y≈9 CSS px 处；这里用比例定位，避免依赖固定像素
      const y = Math.round(im.h * 0.035);
      for (let x = Math.round(im.w * 0.06); x < im.w * 0.94; x++) {
        const i = (y * im.w + x) * 4;
        tot++;
        // 白色 (#fff) 或浅灰线 (#e4e4e0)：R>200, G>200, B>180
        const r = im.data[i], g = im.data[i + 1], b = im.data[i + 2];
        if (r > 200 && g > 200 && b > 180) wall++;
      }
      return { ratio: tot ? wall / tot : 0, w: im.w, h: im.h };
    } catch (e) { return { err: String(e.message) }; }
  }

  const shot = async (rect, name, scale) => {
    const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
    const raw = img.toPNG();
    let c = nativeImage.createFromBuffer(raw);
    const s = c.getSize();
    if (scale && scale !== 1) c = c.resize({ width: Math.round(s.width * scale), height: Math.round(s.height * scale), quality: 'best' });
    const buf = c.toPNG();
    fs.writeFileSync(path.join(OUT, name), buf);
    return { size: c.getSize(), check: rect ? checkBorder(raw) : null };
  };

  console.log('\n== 四态截图 ==');
  let bad = 0;
  for (const st of STATES) {
    await js(`(function(){
      var g=document.getElementById('pixel-girl'), s=document.getElementById('girl-scene'),
          c=document.getElementById('girl-cap');
      if(g) g.dataset.state=${JSON.stringify(st)};
      if(s) s.dataset.state=${JSON.stringify(st)};
      if(c) c.textContent=({IDLE:'待机',THINKING:'思考中…',TOOL:'处理中…',DONE:'完成！'})[${JSON.stringify(st)}];
      return 1; })()`);
    await sleep(500);
    const now = await js(`(function(){
      const f=(s)=>{const e=document.querySelector(s);return e?getComputedStyle(e).display:'无';};
      // 键盘：IDLE 只该有 .f-key 那一个键在闪；TOOL 该是 8 个键全闪。
      // 这条是给「把 i:nth-child(2) 换成 i.f-key」那次槽位改造留的回归位 ——
      // 数位置的写法改错了不会报错，只会静默地换个键闪，所以必须量 animationName。
      const keys = Array.prototype.map.call(document.querySelectorAll('.of-keyboard i'), function(e){
        return getComputedStyle(e).animationName;
      });
      return {state:document.getElementById('pixel-girl').dataset.state,
              cap:document.getElementById('girl-cap').textContent,
              bubble:f('.of-bubble'), gear:f('.of-gear'), stars:f('.of-stars'),
              keyCount: keys.length,
              keysAnimated: keys.filter(function(n){ return n && n !== 'none'; }).length,
              fKeyIdx: Array.prototype.findIndex.call(document.querySelectorAll('.of-keyboard i'),
                function(e){ return e.classList.contains('f-key'); }) }; })()`);
    // 断言：键的数量、IDLE/TOOL 各自动画几个键（顺便确认 .f-key 真的挂在第 2 个键上）
    if (now.keyCount !== 8) { console.log('  ❌ 键盘键数不是 8，实际 ' + now.keyCount); bad++; }
    if (st === 'TOOL' && now.keysAnimated !== 8) {
      console.log('  ❌ TOOL 态应该是 8 个键全闪，实际 ' + now.keysAnimated); bad++;
    } else if (st === 'IDLE' && now.keysAnimated !== 1) {
      console.log('  ❌ IDLE 态应该只有 1 个键闪，实际 ' + now.keysAnimated); bad++;
    } else if (st === 'THINKING' || st === 'DONE') {
      // 这两种状态不该有键盘动画（气泡/星星才是主角）
      if (now.keysAnimated !== 0) { console.log('  ❌ ' + st + ' 态键盘不该闪，实际 ' + now.keysAnimated); bad++; }
    }
    if (now.fKeyIdx !== 1) { console.log('  ❌ .f-key 应该挂在下标 1（第 2 个键），实际 ' + now.fKeyIdx); bad++; }
    const r = await js(`(function(){ var b=document.getElementById('girl-scene').getBoundingClientRect();
      return {x:b.left,y:b.top,width:b.width,height:b.height}; })()`);
    const P = 8;
    const rect = {
      x: Math.max(0, Math.round((r.x - P) * dpr)),
      y: Math.max(0, Math.round((r.y - P) * dpr)),
      width: Math.round((r.width + P * 2) * dpr),
      height: Math.round((r.height + P * 2) * dpr)
    };
    const res = await shot(rect, `20-girl-${st}.png`, 2);
    const ck = res.check || {};
    const ok = !ck.err && ck.ratio >= 0.9;
    if (!ok) bad++;
    console.log(`  [${st}] ${JSON.stringify(now)}`);
    console.log(`      📷 20-girl-${st}.png ${res.size.width}x${res.size.height}` +
      (ck.err ? `  ❌ 解码失败:${ck.err}` : `  边框行深色占比=${(ck.ratio * 100).toFixed(0)}% ${ok ? '✅' : '❌ 疑似被别的窗口盖住／截图区域不对'}`));
  }

  // 还原 IDLE，再来一张整窗
  await js(`(function(){ var g=document.getElementById('pixel-girl'), s=document.getElementById('girl-scene'),
      c=document.getElementById('girl-cap'); if(g)g.dataset.state='IDLE'; if(s)s.dataset.state='IDLE'; if(c)c.textContent='待机'; return 1; })()`);
  await sleep(700);
  const full = await shot(null, '21-welcome-full.png', 1);
  console.log(`  📷 21-welcome-full.png ${full.size.width}x${full.size.height}`);

  console.log(bad ? `\n❌ 有 ${bad} 张图没通过像素自检（别拿它们下结论）` : '\n✅ 吉祥物截图完成（四张都通过像素自检）');
  app.exit(bad ? 2 : 0);
});

app.on('window-all-closed', () => app.exit(0));
