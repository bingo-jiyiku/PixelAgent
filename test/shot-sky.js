/* ============================================================
   test/shot-sky.js —— 窗户五档天色截图（老板 2026-10-12：想看五档）
   ------------------------------------------------------------
   跑法：npm run shot:sky

   做三件事：
   1) 逐档写 of-window[data-time]，每档截一张吉祥物区特写（22-sky-<档>.png）
   2) 自检 A：五档的窗口背景渐变必须互不相同（天色真的切换了，不是摆设）
   3) 自检 B：每档该动的元素要在动（太阳浮/云飘/星闪），
      用 getComputedStyle 的 animationName 验证 —— CSS 写错了不会报错，
      只会静默不动，必须数字上确认
   坑（继承自 shot-girl.js）：capturePage 可能截到别的窗口，
   对策：show+focus+setAlwaysOnTop+moveTop 顶到最前。
   ============================================================ */
'use strict';

const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息 → 停在欢迎页
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEGS = ['morning', 'noon', 'afternoon', 'evening', 'night'];

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });

  // 顶到最前，别让别的实例盖住（坑一对策）
  win.show(); win.focus(); win.setAlwaysOnTop(true);
  if (typeof win.moveTop === 'function') win.moveTop();
  await sleep(1500);

  const js = (code) => win.webContents.executeJavaScript(code);
  const dpr = await js('window.devicePixelRatio || 1');

  let bad = 0;
  const bgs = [];

  // tick() 每秒会用真实时间覆盖 of-window 的 data-time —— 直接改 DOM 一秒内就被打回。
  // 对策：伪造 Date.prototype.getHours，让渲染层自己的 tick() 也乖乖切到我要的档。
  const FAKE_HOUR = { morning: 7, noon: 11, afternoon: 15, evening: 20, night: 1 };

  for (const seg of SEGS) {
    await js(`(function(){ var H = ${FAKE_HOUR[seg]}; Date.prototype.getHours = function(){ return H; };
      document.getElementById('of-window').dataset.time = ${JSON.stringify(seg)}; return 1; })()`);
    await sleep(1200);   // 故意跨过一个 tick（1s）：验证伪造生效、档位不被真实时钟打回

    // 自检 B：该档的动画元素 computedStyle 确认
    const info = await js(`(function(){
      var w = document.getElementById('of-window');
      var sun = w.querySelector('.of-sun');
      var clouds = Array.prototype.map.call(w.querySelectorAll('.of-cloud'), function(c){ return getComputedStyle(c).animationName; });
      var miniStar = getComputedStyle(w.querySelector('i'), '::before').animationName;
      var sts = Array.prototype.map.call(w.querySelectorAll('.of-st'), function(s){ return getComputedStyle(s).animationName; });
      return { time: w.dataset.time,
               bg: getComputedStyle(w).backgroundImage,
               sunAnim: sun ? getComputedStyle(sun).animationName : '无元素',
               clouds: clouds, miniStar: miniStar, sts: sts };
    })()`);
    bgs.push(info.bg);

    // 期望：白天三档太阳在动；中午/下午两朵云都在动；晚上/深夜小星在闪
    const sunOk = ['morning', 'noon', 'afternoon'].includes(seg) ? info.sunAnim.indexOf('of-sunbob') >= 0
                : ['evening', 'night'].includes(seg) ? info.sunAnim === 'none'
                : true;
    const cloudOk = (seg === 'noon' || seg === 'afternoon')
      ? info.clouds.length === 2 && info.clouds.every((n) => n.indexOf('of-drift') >= 0)
      : info.clouds.every((n) => n === 'none');
    const starOk = (seg === 'evening' || seg === 'night') ? info.miniStar.indexOf('of-tw') >= 0 : info.miniStar === 'none';

    console.log(`[${seg}] 太阳动画=${info.sunAnim}  云动画=${JSON.stringify(info.clouds)}  小星=${info.miniStar}  三星=${JSON.stringify(info.sts)}`);
    if (!sunOk) { console.log('  ❌ 太阳动画状态不对'); bad++; }
    if (!cloudOk) { console.log('  ❌ 云动画状态不对'); bad++; }
    if (!starOk) { console.log('  ❌ 星星动画状态不对'); bad++; }

    // 截图：吉祥物区特写（含 8px 外边距），2 倍放大看得清
    const r = await js(`(function(){ var b = document.getElementById('girl-scene').getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
    const P = 8;
    const rect = {
      x: Math.max(0, Math.round((r.x - P) * dpr)),
      y: Math.max(0, Math.round((r.y - P) * dpr)),
      width: Math.round((r.width + P * 2) * dpr),
      height: Math.round((r.height + P * 2) * dpr)
    };
    const img = await win.webContents.capturePage(rect);
    const c = nativeImage.createFromBuffer(img.toPNG()).resize({ width: rect.width * 2, height: rect.height * 2, quality: 'best' });
    fs.writeFileSync(path.join(OUT, `22-sky-${seg}.png`), c.toPNG());
    console.log(`  📷 22-sky-${seg}.png`);
  }

  // 自检 A：五档背景渐变互不相同
  const uniq = new Set(bgs);
  if (uniq.size !== SEGS.length) { console.log(`❌ 五档背景只有 ${uniq.size} 种（应该 5 种互不相同）`); bad++; }
  else console.log('✅ 五档背景互不相同');

  console.log(bad ? `\n❌ ${bad} 项自检没过（别只看图下结论）` : '\n✅ 五档天色截图完成，动画全部在动');
  app.exit(bad ? 2 : 0);
});

app.on('window-all-closed', () => app.exit(0));
