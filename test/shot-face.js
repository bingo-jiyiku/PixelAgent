/* ============================================================
   test/shot-face.js —— 活眼睛 / 表情系统取证
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/shot-face.js

   老板 2026-10-14：「像素这个吉祥物是真的有表情的，眼睛要有动画，会眨眼、
   会愤怒、会发愁、会思考、会大笑，而不是加两个笔画上去」

   本文件量什么（全部**逐像素 / 逐元素实测**，不靠肉眼）：
     ① 无眼底图真的没有眼睛残留（眼框内不存在深色睫毛细 / 高饱和虹膜像素）
     ② 活眼睛元素存在且几何对（左右两只、宽高非 0、间距 = 原图 76×k）
     ③ 四态下眼睛 **真的不一样**（眼皮高度 / 虹膜位置 / 形态 有可测差异）
     ④ 眨眼真的会闭（在 6s 窗口内采到"眼皮吃满"的帧）
     ⑤ 眉毛位置**落在脸内**（不是飘在刘海上——旧版就是在 y63 的头发上）
     ⑥ 眼睛是 .of-girl 的子元素（人物动它跟着动，不得脱开）
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

  /* ---- ① 结构：of-girl 现在必须是容器，眼睛是子元素 ---- */
  const dom = await js(`(function(){
    var o = document.getElementById('pixel-girl');
    var g = document.querySelector('.of-girl');
    if (!o || !g) return { miss: true };
    var body = g.querySelector('.girl-body');
    var eyes = g.querySelectorAll('.of-eye');
    var balls = g.querySelectorAll('.of-eye .ball');
    var brows = g.querySelectorAll('.of-brows i');
    return {
      girlTag: g.tagName,
      bodySrc: body ? (body.getAttribute('src')||'') : 'NONE',
      bodyInside: !!(body && g.contains(body)),
      eyeCount: eyes.length,
      ballCount: balls.length,
      ballSrc: Array.prototype.map.call(balls, function(b){
        return (b.getAttribute('src')||'').split('/').pop(); }).join(','),
      browCount: brows.length,
      eyesInsideGirl: !!(g.querySelector('.of-eyes') && g.contains(g.querySelector('.of-eyes'))),
      browInsideGirl: !!(g.querySelector('.of-brows') && g.contains(g.querySelector('.of-brows'))),
      oldBrowGone: o.querySelector('.of-brow') === null
    };
  })()`);
  console.log('  DOM:', JSON.stringify(dom));
  t('of-girl 是容器（眼睛要能跟着人物动，不能是 <img>）', dom.girlTag, 'DIV');
  t('人物图用的是无眼底图 girl-blank.png', /girl-blank\.png$/.test(dom.bodySrc), true);
  t('左右两只活眼睛', dom.eyeCount, 2);
  t('两只眼睛用的是原图裁下来的真眼睛贴图', dom.ballSrc, 'eye-l.png,eye-r.png');
  t('两只活眉毛', dom.browCount, 2);
  t('眼睛在 .of-girl 里（跟着人物一起动）', dom.eyesInsideGirl, true);
  t('眉毛在 .of-girl 里（跟着人物一起动）', dom.browInsideGirl, true);
  t('旧的静止眉毛元素已删除（飘在刘海上那个）', dom.oldBrowGone, true);

  /* ---- ② 无眼底图：眼框内不许有眼睛残留 ---- */
  const IMG = 'assets/girl-blank.png';
  const png = fs.readFileSync(path.join(__dirname, '..', IMG));
  const t2 = await js(`(async function(){
    var img = new Image();
    await new Promise(function(res, rej){ img.onload=res; img.onerror=rej; img.src=${JSON.stringify(IMG)}; });
    var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    var g2 = c.getContext('2d'); g2.drawImage(img, 0, 0);
    var d = g2.getImageData(0,0,c.width,c.height).data;
    var sat = function(r,gg,b){ return Math.max(r,gg,b)-Math.min(r,gg,b); };
    // 眼框（原图坐标）。★ 只量**眼睛本体**（虹膜 109-206 / y149-178）外扩到安全余量：
    //   原图睫毛细 / 刘海黑边紧贴眼框边缘，框画大一点点就会把邻接的刘海像素算成"残留"
    //   （我第一版框画到 94-147、132-187，多算进 6 个刘海像素 → 假红）。
    var boxes = [[104,144,139,183],[180,144,215,183]];
    var dark=0, irism=0;
    boxes.forEach(function(bx){
      for (var y=bx[1]; y<=bx[3]; y++) for (var x=bx[0]; x<=bx[2]; x++){
        var i=(y*c.width+x)*4, r=d[i], gg=d[i+1], bb=d[i+2];
        if (r<170 && gg<170 && bb<180) dark++;
        if (sat(r,gg,bb) > 95 && r > 180) irism++;
      }
    });
    return { w:c.width, h:c.height, dark:dark, iris:irism };
  })()`);
  console.log('  ℹ 无眼底图', t2.w + 'x' + t2.h, '眼框内残留：深色', t2.dark, '/ 虹膜', t2.iris);
  t('无眼底图尺寸与原图一致（315x432）', t2.w + 'x' + t2.h, '315x432');
  t('眼框内无睫毛/眼线残留', t2.dark, 0);
  t('眼框内无虹膜残留', t2.iris, 0);

  /* ---- ③ 几何：两只眼相对位置 = 原图 76 × k ---- */
  const geo = await js(`(function(){
    var l = document.querySelector('.of-eye-l'), r = document.querySelector('.of-eye-r');
    var bl = l.getBoundingClientRect(), br = r.getBoundingClientRect();
    return { lx: Math.round((bl.left-br.left + (br.left-bl.left))*100)/100,
             gap: Math.round((br.left - bl.left)*100)/100,
             w: Math.round(bl.width*100)/100, h: Math.round(bl.height*100)/100 };
  })()`);
  console.log('  ℹ 眼睛几何:', JSON.stringify(geo));
  t('眼睛尺寸非 0（真的画出来了）', geo.w > 0 && geo.h > 0, true);
  // ★ 两眼中距要看**眼框**中心（原图左框中心 111 / 右框中心 203 → 差 92），
  //   不是我第一版算的"虹膜中心距 76" —— 虹膜两侧还有眼白，眼框才是眼睛的真实占位。
  //   92 × (100/315) = 29.2px
  t('两眼框中距 ≈ 29.2px（原图 92 × 100/315）', Math.abs(geo.gap - 29.2) < 1.5, true);

  /* ---- ④ 眉毛必须落在脸内（不是刘海）---- */
  const browGeo = await js(`(function(){
    var g = document.querySelector('.of-girl').getBoundingClientRect();
    var l = document.querySelector('.of-brow-l').getBoundingClientRect();
    return { girlTop: Math.round(g.top), girlH: Math.round(g.height),
             browY: Math.round(l.top - g.top), browH: Math.round(l.height) };
  })()`);
  console.log('  ℹ 眉毛相对人物:', JSON.stringify(browGeo));
  // 实测：人物图高 137px（432 原图 × 0.3175），脸（含额）在原图 y110-211 = 25%-49%。
  // 眉毛压在眼睛上方 6px（原图 y128）→ 应落在 28%-36%。旧版是 99/137 = 72%（在刘海上）。
  const browPct = browGeo.browY / browGeo.girlH;
  console.log(`  ℹ 眉毛位置占人物高度 ${(browPct*100).toFixed(1)}%（脸区应 28%-38%，旧版 72%=在刘海上）`);
  t('眉毛落在脸区（眼框与发际线之间），不是飘在刘海/身上', browPct > 0.25 && browPct < 0.38, true);

  /* ---- ⑤ 四态眼睛形态必须真的不同 ---- */
  // ★ 量"眼睛闭了多少" = 数眼区里的深色像素占比。
  //   ⚠ 不用 capturePage(小矩形) —— 它对非前台/被遮挡的窗口会捕到错内容
  //     （TOOL 态曾报 100% 全黑，而截图明明白白不是）。这是已知坑（memory 里记过）。
  //   ✅ 改成：抓**整张人物图**（这个一直是对的），再在 Node 里按坐标切出眼区数深色。
  const shoot = async (state, name, extraClass) => {
    await js(`(function(){
      var o=document.getElementById('pixel-girl');
      o.setAttribute('data-state', ${JSON.stringify(state)});
      o.classList.remove('mood-worry','mood-angry');
      ${extraClass ? `o.classList.add(${JSON.stringify(extraClass)});` : ''}
      return 1; })()`);
    // ⚠ 量之前先停掉一切动画再等一帧 ——
    //   ① of-glare/of-rage/of-laugh/of-blink 是循环动画，截图会捕到哪一帧不确定
    //      （实测 TOOL 报过 100% 全黑，同一状态 probe 单独跑却是 31%）。
    //   ② capturePage 对动画中的内容可能捕到**上一帧**（本机已知坑）。
    //   ③ 顺手把眨眼层强制收起，免得恰好捕到眨眼那一瞬。
    await js(`(function(){
      var st=document.createElement('style'); st.id='face-shot-freeze';
      st.textContent='.of-eye *,.of-eye{animation:none !important;} .of-eye .blink{transform:scaleY(0) !important;}';
      document.head.appendChild(st); return 1; })()`);
    await sleep(650);
    const geom = await js(`(function(){
      var g=document.querySelector('.of-girl').getBoundingClientRect();
      var e=document.querySelector('.of-eye-l').getBoundingClientRect();
      var o=document.getElementById('pixel-girl');
      var l=document.querySelector('.of-eye-l');
      var sm=l.querySelector('.smile'), ball=l.querySelector('.ball');
      return { gx:g.left, gy:g.top, gw:g.width, gh:g.height,
               ex:e.left, ey:e.top, ew:e.width, eh:e.height,
               smileShown: getComputedStyle(sm).display !== 'none',
               ballHidden: getComputedStyle(ball).visibility === 'hidden' }; })()`);
    const pad = 6;
    const rect = { x: Math.max(0, Math.round(geom.gx) - pad), y: Math.max(0, Math.round(geom.gy) - pad),
                   width: Math.round(geom.gw) + pad * 2, height: Math.round(geom.gh) + pad * 2 };
    let cs = { cover: -1, smileShown: geom.smileShown, ballHidden: geom.ballHidden };
    try {
      const img = await win.webContents.capturePage(rect);
      fs.writeFileSync(path.join(OUT, name), img.toPNG());
      const size = img.getSize();
      const scale = size.width / rect.width;
      // 眼区（换算到截图的实际像素坐标）。顶部再往下 4px 避开旋转后垂进来的眉毛。
      const ex0 = Math.round((geom.ex - rect.x) * scale);
      const ey0 = Math.round((geom.ey - rect.y + 4) * scale);
      const ex1 = Math.round((geom.ex + geom.ew - rect.x) * scale);
      const ey1 = Math.round((geom.ey + geom.eh - rect.y) * scale);
      // ⚠ 不要在全图 buffer 上按坐标索引 —— 我这么算过一版，TOOL 报 100%
      //   （实测那一帧其实是 30%）。toBitmap() 的步长/坐标换算这里不可靠。
      //   ✅ 改成先 crop 出眼区小图，再在小图上遍历：与 probe 验证过的做法一致。
      const crop = img.crop({
        x: Math.max(0, ex0), y: Math.max(0, ey0),
        width: Math.max(1, ex1 - ex0), height: Math.max(1, ey1 - ey0)
      });
      const cb = crop.toBitmap();                        // BGRA
      // ★ 度量口径演进（第三次才对）：
      //   眼皮改成**肤色**之后，"深色像素占比"不再是闭眼程度（眼皮不再是黑的），
      //   TOOL 反而从 29% 掉到 2.6% —— 量错了对象。
      //   ⇒ 正确口径：量**还能看见多少虹膜**（饱和粉）。虹膜露得越少 = 眼闭得越狠。
      //     虹膜色 ≈ (209,95,128)：R 明显大于 G/B、且 R>170 ⇒ 用它当判据。
      let iris = 0, total = 0;
      for (let i = 0; i + 3 < cb.length; i += 4) {
        const b2 = cb[i], g2 = cb[i+1], r2 = cb[i+2];    // B,G,R
        total++;
        if (r2 > 170 && r2 - g2 > 55 && r2 - b2 > 40) iris++;
      }
      // cover = 被盖住的比例 = 100 - 还露着的虹膜占比（相对"全睁"的基准在断言里比）
      cs.irisPct = total ? Math.round(iris / total * 1000) / 10 : -1;
      cs.cover = cs.irisPct;   // 兼容旧字段名
      cs.wh = crop.getSize().width + 'x' + crop.getSize().height;
    } catch (e) { cs.err = e.message; }
    await js(`(function(){ var st=document.getElementById('face-shot-freeze'); if(st) st.remove(); return 1; })()`);
    console.log(`  [${state}${extraClass ? '+' + extraClass : ''}] 虹膜露出 ${cs.cover}% (${cs.wh}) / 笑眼 ${cs.smileShown} / 眼球藏 ${cs.ballHidden}`);
    return cs;
  };

  const idle = await shoot('IDLE', 'face-1-idle.png');
  const think = await shoot('THINKING', 'face-2-think.png');
  const tool = await shoot('TOOL', 'face-3-tool.png');
  const done = await shoot('DONE', 'face-4-done.png');
  const worry = await shoot('IDLE', 'face-5-worry.png', 'mood-worry');
  const angry = await shoot('IDLE', 'face-6-angry.png', 'mood-angry');

  t('待机 vs 思考：虹膜露出变少（思考时眯一点）',
    idle.cover - think.cover > 1, true);
  t('待机 vs 干活：虹膜露出明显变少（恼火眯眼）',
    idle.cover - tool.cover > 3, true);
  t('待机 vs 大笑：换成月牙笑眼（笑眼弧出现 + 眼球藏起）',
    (done.smileShown && done.ballHidden), true);
  t('待机 vs 发愁：虹膜露出变少（耷拉眼）',
    idle.cover - worry.cover > 2, true);
  t('待机 vs 发怒：虹膜露出最少（压得最狠）',
    idle.cover - angry.cover > 5, true);
  t('发怒比干活露得更少（怒 > 干活）', tool.cover > angry.cover, true);
  // 各态互不相同 ⇒ 多种表情确实画出了多种
  const lh = [idle.cover, think.cover, tool.cover, worry.cover, angry.cover];
  console.log('  ℹ 五态虹膜露出量(%):', lh.join(' / '));
  t('五态虹膜露出量至少有 4 种不同值', new Set(lh).size >= 4, true);
  // 斜切（皱眉瞪眼）只在情绪态出现
  const polyOf = async (state) => js(`(function(){
    var o=document.getElementById('pixel-girl');
    var bak=o.getAttribute('data-state'), cls=o.className;
    o.setAttribute('data-state', ${JSON.stringify(state)});
    var v = getComputedStyle(document.querySelector('.of-eye-l .lid')).clipPath;
    o.setAttribute('data-state', bak); o.className = cls;
    return /polygon/.test(v) ? 'polygon' : 'inset';
  })()`);
  t('干活眼皮是斜切（皱眉瞪眼）', await polyOf('TOOL'), 'polygon');
  t('发愁眼皮是斜切（耷拉眼）', await js(`(function(){
    var o=document.getElementById('pixel-girl'); o.classList.add('mood-worry');
    var v = /polygon/.test(getComputedStyle(document.querySelector('.of-eye-l .lid')).clipPath) ? 'polygon':'inset';
    o.classList.remove('mood-worry'); return v; })()`), 'polygon');
  t('发怒眼皮是斜切（暴怒）', await js(`(function(){
    var o=document.getElementById('pixel-girl'); o.classList.add('mood-angry');
    var v = /polygon/.test(getComputedStyle(document.querySelector('.of-eye-l .lid')).clipPath) ? 'polygon':'inset';
    o.classList.remove('mood-angry'); return v; })()`), 'polygon');
  // 待机：眼皮高度为 0（不遮盖）、且没有 polygon 斜切
  t('待机眼皮不遮盖（高度 0）',
    await js(`parseFloat(getComputedStyle(document.querySelector('.of-eye-l .lid')).height) < 0.5`), true);
  t('待机眼皮不斜切（正常眼型）',
    await js(`(getComputedStyle(document.querySelector('.of-eye-l .lid')).clipPath === 'none')`), true);

  /* ---- ⑥ 眨眼：6 秒窗口内必须采到"闭眼"帧 ---- */
  await js(`document.getElementById('pixel-girl').setAttribute('data-state','IDLE'); 1`);
  await sleep(300);
  // 眨眼看 .blink 覆盖层的 scaleY（0=睁，1=闭）。不再看 .lid 的 height ——
  // 改成覆盖层方案后 .lid 是常态眼型、不再变（见 style.css 的说明）。
  let blinkSeen = false, samples = [];
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const s = await js(`(function(){
      var m = getComputedStyle(document.querySelector('.of-eye-l .blink')).transform;
      var mt = /matrix\\(([^)]+)\\)/.exec(m);
      return mt ? Math.round(parseFloat(mt[1].split(',')[3])*100)/100 : -1;
    })()`);
    samples.push(s);
    if (s > 0.5) { blinkSeen = true; break; }
  }
  console.log('  ℹ 眨眼层 scaleY 采样(前段):', samples.slice(0, 18).join(', '));
  t('6 秒内眼睛真的眨过（眨眼层展开）', blinkSeen, true);

  console.log(`\n${RESULT.pass === 0 ? '' : '✅ '}${RESULT.pass} 通过 / ${RESULT.fail} 失败`);
  if (RESULT.bad.length) console.log('  失败项:', RESULT.bad.join(' | '));
  app.exit(RESULT.fail ? 1 : 0);
}).catch((e) => { console.error('❌', e); app.exit(1); });
