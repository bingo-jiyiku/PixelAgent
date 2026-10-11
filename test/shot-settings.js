/* ============================================================
   test/shot-settings.js —— 设置面板取证：量排版 + 截图
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/shot-settings.js

   为什么要单独一个脚本：
   原来 shots/10-settings.png 拍出来的是**模型选择框** —— 而且
   09-model.png 与 10-settings.png 字节数完全相同（106198），
   静态同帧才会字节一致 ⇒ 那张"设置截图"根本没拍到设置面板。
   原因是两个遮罩都是 `.mask { z-index:50 }`、`#mask-model` 在 DOM 里更靠后，
   它会盖在 `#mask` 上面；而调用方写的是 `if(b) b.click()` —— 找不到按钮就**不吭声**。
   教训：**"我没找到"和"它不存在"必须是两句不同的话。**
   所以本脚本立三条规矩：
     ① 每步操作后**回读**真实状态，不假设点成功了；
     ② 每个测量分三种结果打印：不存在 / 存在但尺寸为 0 / 正常，绝不混成一句；
     ③ 拍照前把两个遮罩的 display 与 DOM 顺序一起打出来，图和日志必须能互相对上。

   ★ 关于"标签有没有被压到换行"这条断言（我在这里栽过）：
     第一版写的是 `scrollWidth > clientWidth`（溢出即换行）。**它是假阴性** ——
     实测 10 个标签的 scrollWidth 与 clientWidth 全等于 136px，3 个字的
     "主题色"和 7 个字的"新消息自动到底"量出来一模一样。
     原因：`white-space: normal` 的元素**换行而不是溢出**，所以 scrollWidth 根本不会涨，
     这条断言在"没换行"和"换了行"两种情况下都返回绿。
     ⇒ 正确判据是**行数**：`盒子高度 ÷ line-height`。下面 `lines()` 就是干这个的。
     并且脚本里带一次**反向验证**（把标签文字临时换成超长串，断言它必须报 lines>=2），
     否则我没法证明这个新判据真的能红。
   ============================================================ */
'use strict';

const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULT = { pass: 0, fail: 0, bad: [] };
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { RESULT.pass++; console.log(`  ✓ ${name}`); }
  else {
    RESULT.fail++; RESULT.bad.push(name);
    console.log(`  ❌ ${name}\n      期望 ${JSON.stringify(want)}\n      实际 ${JSON.stringify(got)}`);
  }
}

/* 量「每个标签占了几行」——换行判据的可复用片段（脚本里注入到渲染进程跑） */
const LABEL_LINES = `(function(){
  var out = [];
  Array.prototype.forEach.call(document.querySelectorAll('.dialog-set .set-lb'), function(e){
    var b = e.getBoundingClientRect();
    var cs = getComputedStyle(e);
    var lh = parseFloat(cs.lineHeight);
    if (!isFinite(lh) || lh <= 0) lh = parseFloat(cs.fontSize) * 1.2;   // line-height:normal 时兜底
    out.push({ txt: e.textContent.trim(), w: Math.round(b.width), h: Math.round(b.height),
               lh: Math.round(lh), lines: Math.max(1, Math.round(b.height / lh)) });
  });
  return out; })()`;

app.whenReady().then(async () => {
  try {
    let win = null;
    for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
    if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
    await new Promise((res) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
      else res();
    });
    win.show(); win.focus(); win.setAlwaysOnTop(true);
    if (typeof win.moveTop === 'function') win.moveTop();
    await sleep(1800);

    const js = (code) => win.webContents.executeJavaScript(code);
    const dpr = await js(`window.devicePixelRatio || 1`);
    console.log('devicePixelRatio =', dpr);

    /* ---------- 0. 先把所有遮罩关干净（回读确认，不假设） ---------- */
    await js(`(function(){
      ['mask','mask-model','mask-input'].forEach(function(id){
        var m=document.getElementById(id); if(m) m.classList.add('hidden');
      });
      return 1; })()`);
    await sleep(500);

    /* ---------- 1. 打开设置面板，回读真实状态 ---------- */
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(1400);            // 里面要真跑一次 pi:info + 拉模型目录
    const st = await js(`(function(){
      var disp = function(id){ var e=document.getElementById(id); if(!e) return 'NOT_FOUND';
        return getComputedStyle(e).display === 'none' ? 'hidden' : 'VISIBLE'; };
      var box = function(sel){ var e=document.querySelector(sel);
        if(!e) return 'NOT_FOUND';
        var b=e.getBoundingClientRect();
        if(!b.width || !b.height) return 'ZERO_SIZE(元素存在但量到 0)';
        return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}; };
      var kids = Array.prototype.map.call(document.body.children, function(e){ return e.id||e.className; });
      return {
        mask: disp('mask'), maskModel: disp('mask-model'), maskInput: disp('mask-input'),
        setBox: box('#mask .dialog-set'), mdlBox: box('#mask-model .dialog-model'),
        setTitle: (document.getElementById('set-title')||{}).textContent,
        order: kids.indexOf('mask') < kids.indexOf('mask-model') ? 'mask 在前/mask-model 在后' : 'mask 在后'
      }; })()`);
    console.log('\n== 打开设置后的真实状态 ==');
    console.log('  #mask         = ' + st.mask);
    console.log('  #mask-model   = ' + st.maskModel);
    console.log('  #mask-input   = ' + st.maskInput);
    console.log('  设置框盒子     = ' + JSON.stringify(st.setBox));
    console.log('  模型框盒子     = ' + JSON.stringify(st.mdlBox));
    console.log('  DOM 顺序       = ' + st.order);
    t('点设置按钮 → #mask 真的显示出来', st.mask, 'VISIBLE');
    t('#mask-model 此刻是关着的（否则它会盖住设置框）', st.maskModel, 'hidden');
    t('设置框量到了真实盒子（不是 0）', typeof st.setBox === 'object', true);
    t('标题不再是一对空括号', /^设置\(\d+ 项\)$/.test(String(st.setTitle)), true);
    console.log('  ℹ 设置面板标题 = ' + JSON.stringify(st.setTitle));

    /* ---------- 1b. Esc：该关面板，且**不能**顺手把正在跑的这轮中断掉 ---------- */
    // 原来的 bug：文档级 keydown 里只有 mask-input / mask-model 两支，
    // 设置面板开着时 Esc 会掉到 doAbort() —— "想关设置"变成"中断掉这一轮"，面板还开着。
    // doAbort 里有 `if (!S.busy) return`，测试时没在跑就什么都看不出来，
    // 所以计数放在 busy 判断之前（见 renderer.js 的 window.__pixelAborts）。
    //
    // ★ 触发条件要写全（我第一版就漏了，被下面那条反向验证当场抓住）：
    //   真实逻辑是 **`document.activeElement !== input` 才 doAbort**。
    //   用户点过面板里的控件（这里模拟为 focus #set-cwd）之后焦点在面板内，
    //   才会掉进 doAbort 那一支。所以下面既断言"没中断"，也把
    //   "此刻焦点确实不在聊天输入框"这个**前提**量出来 —— 否则这条断言可能恒绿。
    const focused = await js(`(function(){
      document.getElementById('set-cwd').focus();
      return { active: document.activeElement.id || document.activeElement.tagName,
               isChatInput: document.activeElement === document.getElementById('input'),
               maskHidden: document.getElementById('mask').classList.contains('hidden') }; })()`);
    const abort0 = await js(`window.__pixelAborts`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(350);
    const esc = await js(`(function(){
      return { hidden: document.getElementById('mask').classList.contains('hidden'),
               aborts: window.__pixelAborts }; })()`);
    console.log('\n== Esc 键 ==');
    console.log('  Esc 前焦点 = #' + focused.active + '（面板开着，焦点在面板内：' + !focused.isChatInput + '）');
    console.log('  Esc 后 #mask 隐藏=' + esc.hidden + '  中断计数 ' + abort0 + ' → ' + esc.aborts);
    t('前提成立：焦点在面板内（不是聊天输入框）', focused.isChatInput, false);
    t('Esc 能关掉设置面板', esc.hidden, true);
    t('Esc 关面板时没有顺手中断正在跑的这轮', esc.aborts, abort0);
    // 反向验证：**没有任何浮层**、且焦点不在聊天输入框时，Esc 应该照旧走中断逻辑。
    // （条件必须写全：输入框在启动时是自动聚焦的，不 blur 掉就永远走不到 doAbort 那一支，
    //   那样这条"反向验证"本身就成了空转 —— 我第一版正是这么错的。）
    await js(`(function(){ if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'null'; })()`);
    await sleep(150);
    const esc2 = await js(`window.__pixelAborts`);
    const esc2b = await js(`(function(){
      var a = document.activeElement;
      return { active: a ? (a.id || a.tagName) : 'null',
               anyMask: ['mask','mask-model','mask-input'].some(function(id){
                 var m=document.getElementById(id); return m && !m.classList.contains('hidden'); }) }; })()`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(250);
    const esc3 = await js(`window.__pixelAborts`);
    console.log('  反向：无浮层 + 焦点=' + esc2b.active + '（无浮层=' + !esc2b.anyMask + '）→ 中断计数 ' + esc2 + ' → ' + esc3);
    t('（反向）无浮层且焦点不在输入框时，Esc 仍然走到中断逻辑 → 上面那条不是空转', esc3 > esc2, true);

    // 后面还要量排版 / 截图，把面板重新打开
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(1200);

    /* ---------- 2. 滚动条：藏起来就没有「下面还有东西」的证据 ---------- */
    const sc = await js(`(function(){ var b=document.getElementById('set-body');
      return { ow: b.offsetWidth, cw: b.clientWidth, sw: b.scrollWidth, sh: b.scrollHeight, ch: b.clientHeight }; })()`);
    console.log('\n== 滚动条 ==');
    console.log('  #set-body offsetWidth=' + sc.ow + ' clientWidth=' + sc.cw +
      ' 内容高=' + sc.sh + ' 可视高=' + sc.ch);
    t('设置面板确实放不下（内容比可视区高）→ 必须有滚动提示', sc.sh > sc.ch, true);
    t('需要滚动时滚动条真的占了宽度（不是隐形的）', sc.ow - sc.cw > 0, true);
    console.log('  ℹ 滚动条实测宽 = ' + (sc.ow - sc.cw) + 'px');

    // 反向验证：把 overflow 关掉，滚动条必须消失（证明上面这条测量真的能分辨）
    const scOff = await js(`(function(){ var b=document.getElementById('set-body');
      var old=b.style.overflowY; b.style.overflowY='hidden';
      var r={ ow:b.offsetWidth, cw:b.clientWidth }; b.style.overflowY=old; return r; })()`);
    t('（反向）把 overflow 关掉后滚动条宽度归零 → 这条测量不是恒真', scOff.ow - scOff.cw, 0);

    /* ---------- 3. 排版量测：标签有没有被压到换行（按行数判，不按 scrollWidth） ---------- */
    const lbs = await js(LABEL_LINES);
    console.log('\n== 标签排版 ==');
    for (const l of lbs) {
      console.log('    · ' + l.txt.padEnd(9) + ' box=' + String(l.w).padStart(3) + 'px 高=' + l.h +
        'px 行高=' + l.lh + ' → ' + l.lines + ' 行 ' + (l.lines > 1 ? '❌ 换行了' : '✓'));
    }
    t('设置面板里有标签（不是空壳）', lbs.length > 5, true);
    t('没有标签被压到换行（136px 够用）', lbs.filter((l) => l.lines > 1).map((l) => l.txt), []);

    // ★ 反向验证：这个判据必须真能红。把第一个标签换成超长串，行数必须 > 1。
    const wrapProbe = await js(`(function(){
      var e = document.querySelector('.dialog-set .set-lb');
      var old = e.textContent;
      e.textContent = '这是一个明显长到必须换行的标签文字ABCDEFGH';
      var r = ${LABEL_LINES};
      e.textContent = old;
      return r[0]; })()`);
    console.log('  ℹ 反向验证：把标签换成超长串 → ' + wrapProbe.lines + ' 行（高 ' + wrapProbe.h + 'px）');
    t('（反向）超长标签必须被判成换行 → 否则"没换行"这条是空转', wrapProbe.lines > 1, true);

    /* ---------- 4. 分段按钮 / 盒子几何 ---------- */
    const segs = await js(`(function(){
      return Array.prototype.map.call(document.querySelectorAll('.dialog-set .seg'), function(e){
        var row = e.closest('.set-row');
        var rb = row ? row.getBoundingClientRect() : null;
        var b = e.getBoundingClientRect();
        return { n: e.querySelectorAll('.seg-b').length, w: Math.round(b.width),
                 overflow: rb ? Math.round(b.right - rb.right) : -999 };
      }); })()`);
    console.log('\n== 分段按钮 ==');
    console.log('  ' + JSON.stringify(segs));
    t('分段按钮组数量正确（Enter / 主题色 / 导出格式）', segs.length, 3);
    t('没有分段按钮组溢出所在行', segs.every((s) => s.overflow <= 1), true);

    /* ---------- 5. 截图：整窗 + 设置框局部（2×） ---------- */
    const shot = async (rect, name, scale) => {
      const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
      let c = nativeImage.createFromBuffer(img.toPNG());
      const s = c.getSize();
      if (scale && scale !== 1) c = c.resize({ width: Math.round(s.width * scale), height: Math.round(s.height * scale), quality: 'best' });
      const buf = c.toPNG();
      fs.writeFileSync(path.join(OUT, name), buf);
      return { size: c.getSize(), bytes: buf.length };
    };

    console.log('\n== 截图 ==');
    const full = await shot(null, '10-settings.png', 1);
    console.log('  📷 10-settings.png（整窗）' + full.size.width + 'x' + full.size.height + '  ' + full.bytes + ' bytes');

    // 局部：按 DOM 给的 rect 裁，绝不手填坐标
    const r = await js(`(function(){ var b=document.querySelector('#mask .dialog-set').getBoundingClientRect();
      return {x:b.left,y:b.top,width:b.width,height:b.height}; })()`);
    const P = 10;
    const rect = {
      x: Math.max(0, Math.round((r.x - P) * dpr)),
      y: Math.max(0, Math.round((r.y - P) * dpr)),
      width: Math.round((r.width + P * 2) * dpr),
      height: Math.round((r.height + P * 2) * dpr)
    };
    const crop = await shot(rect, '10-settings-crop.png', 2);
    console.log('  📷 10-settings-crop.png（设置框局部 2×）' + crop.size.width + 'x' + crop.size.height + '  ' + crop.bytes + ' bytes');

    /* ---------- 6. 换成非默认主题色，验证「换皮」真的换了 ---------- */
    // 注意：不能用 `.m.user .who` —— 没发过消息时它**不存在**，
    // 第一次写这个脚本就是在这里 null.textContent 抛异常、把整个进程挂住了
    // （未处理的 Promise rejection 不会让 app.exit 跑到）。用一定存在的元素。
    const preLav = await js(`getComputedStyle(document.documentElement).getPropertyValue('--lav').trim()`);
    await js(`(function(){
      var segs=document.querySelectorAll('#set-accent .seg-b');
      for (var i=0;i<segs.length;i++) if (segs[i].dataset.v==='teal') segs[i].click();
      return 1; })()`);
    await sleep(400);
    const teal = await js(`(function(){
      var pick = function(sel){ var e=document.querySelector(sel); if(!e) return 'NOT_FOUND';
        return getComputedStyle(e).backgroundColor; };
      return { lav: getComputedStyle(document.documentElement).getPropertyValue('--lav').trim(),
               bar: pick('#mask .win-bar'), mug: pick('.of-mug'),
               accentSw: pick('#set-accent .seg-b[data-v="teal"]') }; })()`);
    console.log('\n== 主题色换皮（点「青瓷」）==');
    console.log('  --lav  ' + preLav + ' → ' + teal.lav);
    console.log('  对话框标题条 = ' + teal.bar + '   办公场景马克杯 = ' + teal.mug);
    t('点色块后 --lav 真的变了', teal.lav !== preLav, true);
    t('对话框标题条跟着变色（不是写死的紫）', teal.bar, 'rgb(79, 156, 147)');
    t('欢迎区吉祥物场景也跟着变色', teal.mug, 'rgb(79, 156, 147)');

    const full2 = await shot(null, '10-settings-teal.png', 1);
    console.log('  📷 10-settings-teal.png（青瓷主题整窗）' + full2.size.width + 'x' + full2.size.height);

    /* ---------- 7. 模型框标题也不该是空括号（顺手核一下） ---------- */
    await js(`(function(){ var c=document.getElementById('set-cancel'); if(c) c.click(); return 1; })()`);
    await sleep(300);
    await js(`document.getElementById('btn-model').click()`);
    for (let i = 0; i < 40; i++) {
      const n = await js(`document.querySelectorAll('#mdl-list .mdl-item').length`);
      if (n > 0) break;
      await sleep(500);
    }
    const mdlTitle = await js(`(document.getElementById('mdl-title')||{}).textContent`);
    console.log('\n== 模型框标题 ==');
    console.log('  ' + JSON.stringify(mdlTitle));
    t('模型框标题带着条数（不是空括号）', /^模型\((\d+|读取中|读取失败)\)$/.test(String(mdlTitle)), true);
    await js(`(function(){ var b=document.getElementById('mdl-x'); if(b) b.click(); return 1; })()`);

    console.log('\n================ 汇总 ================');
    console.log('PASS ' + RESULT.pass + ' / FAIL ' + RESULT.fail);
    if (RESULT.bad.length) console.log('失败项: ' + RESULT.bad.join(' | '));
    app.exit(RESULT.fail ? 1 : 0);
  } catch (err) {
    console.log('❌ 脚本自己抛异常了（别把它读成产品缺陷）: ' + (err && err.message));
    console.log(err && err.stack);
    app.exit(3);
  }
});

app.on('window-all-closed', () => app.exit(0));
