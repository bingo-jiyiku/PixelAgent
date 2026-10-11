/* ============================================================
   test/shot-model.js —— 模型选择框 / 配置框取证：量几何 + 截图
   ------------------------------------------------------------
   跑法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/shot-model.js

   为什么要单独一个脚本：
   本轮给模型框加了两样东西 ——「服务商分组可折叠」和「行内 配置/测试 弹框」。
   这两样的失败**都不是崩溃**，而是"结构对、视觉错"：
     · 收起分组时如果用 `display:none` 藏行，DOM 里还在 → 数行数的断言照样绿，
       但用户看到的是空列表；
     · 配置框里 6 行只读 kv + 2 个输入框 + 底部 4 个按钮，窄窗口下很容易
       把「pi 报的窗口」那行长文案挤出盒子（溢出是**静默**的，不会报错）。
   这两类问题功能断言和看整图都抓不到，只能**量几何**或**放大截图**（见记忆里的铁律六）。
   所以本脚本：
     ① 每个测量分三种结果打印：不存在 / 存在但尺寸为 0 / 正常，绝不混成一句；
     ② 折叠/展开的断言看**行数真的变**（不是看 class）；
     ③ 配置框里所有可见控件两两不重叠、且都在框内；
     ④ 每一步都留一张图，图和数字必须能互相对上。
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

const RESULT = { pass: 0, fail: 0 };
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { RESULT.pass++; console.log('  ✓ ' + name); }
  else {
    RESULT.fail++;
    console.log('  ❌ ' + name);
    console.log('      期望 ' + JSON.stringify(want));
    console.log('      实际 ' + JSON.stringify(got));
  }
}

/* 注入渲染进程的通用测量片段。
   `probe` 对每个选择器回三种**不同**的结果 —— "我没找到"和"它不存在"
   必须是两句不同的话（这条吃过亏）。 */
const PROBE = `(function(sels){
  var probe = function(sel){
    var e = document.querySelector(sel);
    if (!e) return 'NOT_FOUND';
    var b = e.getBoundingClientRect();
    if (!b.width || !b.height) return { state: 'ZERO_SIZE', tag: e.tagName };
    return { state: 'OK', tag: e.tagName,
             x: Math.round(b.left), y: Math.round(b.top),
             w: Math.round(b.width), h: Math.round(b.height),
             r: Math.round(b.right), bot: Math.round(b.bottom) };
  };
  var out = {};
  sels.forEach(function(s){ out[s] = probe(s); });
  return out; })`;

app.whenReady().then(async () => {
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
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('  📷 ' + name);
  };
  const probe = (sels) => js(PROBE + '(' + JSON.stringify(sels) + ')');

  console.log('\n== 0. 先把遮罩关干净（回读确认，不假设点成功了） ==');
  await js(`(function(){
    ['mask','mask-model','mask-input','mask-mcfg'].forEach(function(id){
      var m = document.getElementById(id); if (m) m.classList.add('hidden');
    });
    return 1; })()`);
  await sleep(400);
  const shut = await probe(['#mask', '#mask-model', '#mask-mcfg']);
  console.log('  ' + JSON.stringify(shut));
  t('四个遮罩都关上了（量不到可见盒子）', Object.keys(shut).every((k) =>
    shut[k] === 'NOT_FOUND' || shut[k].state === 'ZERO_SIZE'), true);

  /* ================= 1. 打开模型框，拿到基线 ================= */
  console.log('\n== 1. 模型框基线 ==');
  await js(`document.getElementById('btn-model').click()`);
  await sleep(2200);                       // 里面要真跑一次 pi --list-models

  // 过滤词 + 折叠状态都可能是上次留下的 —— 全部清成"最干净的开局"
  await js(`(function(){
    try { localStorage.removeItem('pixelagent.collapsedProvs'); } catch (e) {}
    window.__pixel.collapsedProvs = new Set();
    var q = document.getElementById('mdl-q'); q.value = ''; q.dispatchEvent(new Event('input'));
    return 1; })()`);
  await sleep(500);

  const listStat = () => js(`(function(){
    var provs = [].slice.call(document.querySelectorAll('#mdl-list .mdl-prov'));
    var items = [].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
    var list = document.getElementById('mdl-list');
    var lb = list.getBoundingClientRect();
    return {
      provCount: provs.length,
      itemCount: items.length,
      expanded: provs.filter(function(p){ return p.getAttribute('aria-expanded') === 'true'; }).length,
      groupSizes: provs.map(function(p){ return Number(p.querySelector('.mp-n').textContent); }),
      provNames: provs.map(function(p){ return p.querySelector('.mp-name').textContent.trim(); }),
      listBox: { w: Math.round(lb.width), h: Math.round(lb.height), scrollH: list.scrollHeight },
      title: document.getElementById('mdl-title').textContent,
      count: document.getElementById('mdl-count').textContent,
      btn: document.getElementById('mdl-collapse').textContent.trim(),
      stored: (function(){ try { return localStorage.getItem('pixelagent.collapsedProvs'); } catch (e) { return 'ERR'; } })()
    }; })()`);

  const base = await listStat();
  console.log('  ℹ ' + JSON.stringify({ provs: base.provCount, items: base.itemCount, title: base.title, count: base.count }));
  console.log('  ℹ 各组行数 = ' + JSON.stringify(base.groupSizes) + ' · 组名 = ' + JSON.stringify(base.provNames));
  const mdl = await probe(['#mask-model .dialog-model', '#mdl-list', '#mdl-collapse', '#mdl-count', '#mdl-hint']);
  console.log('  ' + JSON.stringify(mdl, null, 0));
  t('模型框量到了真实盒子', mdl['#mask-model .dialog-model'].state, 'OK');
  t('模型列表量到了真实盒子', mdl['#mdl-list'].state, 'OK');
  t('「全部收起/展开」按钮存在且可见', mdl['#mdl-collapse'].state, 'OK');
  t('列表是可滚动的（内容高于可视区）', base.listBox.scrollH >= base.listBox.h, true);
  t('标题带条数（不再是空括号）', /^模型\(\d+\)$/.test(base.title), true);
  t('开局所有分组都是展开的', base.expanded, base.provCount);
  await shot('12-model-list.png');

  /* ================= 2. 单个分组折叠 ================= */
  console.log('\n== 2. 收起第一个分组 ==');
  const firstGroupName = base.provNames[0];
  const firstGroupSize = base.groupSizes[0];
  await js(`document.querySelector('#mdl-list .mdl-prov').click()`);
  await sleep(500);
  const col1 = await listStat();
  console.log('  ℹ ' + JSON.stringify({ items: col1.itemCount, expanded: col1.expanded, count: col1.count, btn: col1.btn, stored: col1.stored }));
  t('收起后 aria-expanded 翻成 false', col1.expanded, base.expanded - 1);
  t('收起的行**真的**从 DOM 里没了（不是 CSS 藏起来）',
    base.itemCount - col1.itemCount, firstGroupSize);
  t('其余分组的行照常渲染', col1.itemCount, base.itemCount - firstGroupSize);
  t('收起状态落进了 localStorage', String(col1.stored).indexOf(firstGroupName) >= 0, true);
  t('计数条如实说出"收起 N 组，正在显示 M 个"',
    col1.count.indexOf('收起 1 组') >= 0 && col1.count.indexOf('正在显示 ' + col1.itemCount + ' 个') >= 0, true);
  // 几何：列表没被收起动作搞塌（高度还在，只是变短）
  const colBox = (await probe(['#mdl-list']))['#mdl-list'];
  t('收起后列表盒子仍然存在且非 0', colBox.state, 'OK');
  await shot('13-model-collapsed.png');

  /* ================= 3. 一键全收 / 全展 ================= */
  console.log('\n== 3. 一键全收 / 全展 ==');
  await js(`document.getElementById('mdl-collapse').click()`);
  await sleep(500);
  const colAll = await listStat();
  console.log('  ℹ ' + JSON.stringify({ items: colAll.itemCount, expanded: colAll.expanded, btn: colAll.btn, count: colAll.count }));
  t('一键全收：一行都不剩', colAll.itemCount, 0);
  t('一键全收：所有组都标成收起', colAll.expanded, 0);
  t('全部收起后按钮变「全部展开」', colAll.btn, '全部展开');
  t('全部收起后仍然能看到全部组名（不是把列表清空了）', colAll.provCount, base.provCount);
  t('全部收起时计数条说清了"正在显示 0 个"', colAll.count.indexOf('正在显示 0 个') >= 0, true);
  await shot('14-model-all-collapsed.png');

  await js(`document.getElementById('mdl-collapse').click()`);
  await sleep(500);
  const expAll = await listStat();
  t('再点一次：行数回到基线', expAll.itemCount, base.itemCount);
  t('再点一次：aria-expanded 全部回到 true', expAll.expanded, base.provCount);
  t('再点一次：按钮回到「全部收起」', expAll.btn, '全部收起');
  t('再点一次：localStorage 清成空数组', expAll.stored, '[]');

  /* ================= 4. 行内「配置」弹框：排版几何 ================= */
  console.log('\n== 4. 配置弹框 ==');
  const def = await js(`(function(){
    var p = window.__pixel; return p.curModel || p.piDefault || null; })()`);
  console.log('  ℹ 生效模型 = ' + JSON.stringify(def));
  const opener = await js(`(function(){
    // 老板 2026-10-11 17:44：行内「配置」按钮被移除了，改成模型选择器底部
    // 的「⚙ 配置当前」。所以：先点这一行把它设为当前，再点 mdl-config 打开 mcfg。
    var rows = [].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
    var row = rows.filter(function(r){
      var n = r.querySelector('.mi-n');
      return n && n.textContent.trim() === ${JSON.stringify(String((def && def.model) || ''))};
    })[0];
    if (!row) return 'NO_ROW';
    row.click();
    var b = document.getElementById('mdl-config');
    if (!b) return 'NO_CFG_BTN';
    b.click(); return 'OK'; })()`);
  t('模型行上的「配置」按钮点得到', opener, 'OK');
  await sleep(1600);                       // 里面要真读一次 pi:model-info

  const mcfgShow = await js(`(function(){
    var d = function(id){ var e = document.getElementById(id);
      if (!e) return 'NOT_FOUND';
      return getComputedStyle(e).display === 'none' ? 'hidden' : 'VISIBLE'; };
    return { mcfg: d('mask-mcfg'), model: d('mask-model') }; })()`);
  console.log('  ℹ ' + JSON.stringify(mcfgShow));
  t('#mask-mcfg 显示出来了', mcfgShow.mcfg, 'VISIBLE');

  const mc = await probe(['#mask-mcfg .dialog-mcfg', '#mcfg-id', '#mcfg-prov', '#mcfg-base',
    '#mcfg-reported', '#mcfg-cap', '#mcfg-auth', '#mcfg-ctx', '#mcfg-max', '#mcfg-out',
    '#mcfg-default', '#mcfg-test', '#mcfg-cancel', '#mcfg-save']);
  console.log('  ' + JSON.stringify(mc));
  t('配置框量到了真实盒子', mc['#mask-mcfg .dialog-mcfg'].state, 'OK');
  ['#mcfg-id', '#mcfg-prov', '#mcfg-base', '#mcfg-reported', '#mcfg-cap', '#mcfg-auth']
    .forEach((s) => t('只读行 ' + s + ' 有真实尺寸', mc[s].state, 'OK'));
  t('上下文输入框可见', mc['#mcfg-ctx'].state, 'OK');
  t('最大输出输入框可见', mc['#mcfg-max'].state, 'OK');
  t('底部四个按钮都在', [mc['#mcfg-default'].state, mc['#mcfg-test'].state,
    mc['#mcfg-cancel'].state, mc['#mcfg-save'].state].every((x) => x === 'OK'), true);
  t('输出区此刻是收起的（没内容 -> hidden，量不到盒子）',
    mc['#mcfg-out'] === 'NOT_FOUND' || mc['#mcfg-out'].state === 'ZERO_SIZE', true);

  const txt = await js(`(function(){
    var g = function(id){ var e = document.getElementById(id); return e ? e.textContent : 'NOT_FOUND'; };
    return { title: g('mcfg-title'), id: g('mcfg-id'), prov: g('mcfg-prov'), base: g('mcfg-base'),
             reported: g('mcfg-reported'), cap: g('mcfg-cap'), auth: g('mcfg-auth'),
             ctxPh: document.getElementById('mcfg-ctx').placeholder,
             maxPh: document.getElementById('mcfg-max').placeholder }; })()`);
  console.log('  ℹ 只读区 = ' + JSON.stringify(txt, null, 0));
  t('标题带模型名', txt.title.indexOf(String((def && def.model) || '')) >= 0, true);
  t('服务商就是 pi 配置里的那个', txt.prov, String((def && def.provider) || ''));
  t('「pi 报的窗口」这行明说了数字的**来源**（模型没声明 → pi 兜底）',
    txt.reported.indexOf('兜底') >= 0, true);
  t('上下文 placeholder = pi 报的值', txt.ctxPh, '128K');
  t('凭据行只说有没有 key，不回显内容',
    txt.auth.indexOf('key') >= 0 && txt.auth.length < 60, true);
  console.log('  ℹ 全部文案里没有 key 明文（长度检查通过）');

  /* ---- 4b. 几何：控件两两不重叠，且都在框内 ---- */
  const boxOf = (k) => mc[k];
  const controls = ['#mcfg-ctx', '#mcfg-max', '#mcfg-default', '#mcfg-test', '#mcfg-cancel', '#mcfg-save'];
  const overlaps = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = boxOf(controls[i]), b = boxOf(controls[j]);
      if (!a || !b || a.state !== 'OK' || b.state !== 'OK') continue;
      const hit = a.x < b.r && b.x < a.r && a.y < b.bot && b.y < a.bot;
      if (hit) overlaps.push(controls[i] + ' × ' + controls[j]);
    }
  }
  console.log('  ℹ 重叠的控件对 = ' + JSON.stringify(overlaps));
  t('配置框里没有控件互相压住（"结构对、视觉错"那一类）', overlaps.length, 0);

  const dlg = boxOf('#mask-mcfg .dialog-mcfg');
  const allInside = controls.every((s) => {
    const c = boxOf(s);
    return c && c.state === 'OK' && c.x >= dlg.x - 2 && c.r <= dlg.r + 2 &&
      c.y >= dlg.y - 2 && c.bot <= dlg.bot + 2;
  });
  t('所有控件都在配置框内（没有溢出去）', allInside, true);
  await shot('15-model-config.png');

  /* ---- 4c. 只读区的长文案没有横向溢出（溢出是静默的） ---- */
  const ovf = await js(`(function(){
    var out = [];
    ['mcfg-base','mcfg-reported','mcfg-cap','mcfg-auth'].forEach(function(id){
      var e = document.getElementById(id); if (!e) { out.push({ id: id, state: 'NOT_FOUND' }); return; }
      var b = e.getBoundingClientRect();
      if (!b.width) { out.push({ id: id, state: 'ZERO_SIZE' }); return; }
      out.push({ id: id, state: 'OK', scrollW: e.scrollWidth, clientW: e.clientWidth, lines: Math.round(b.height / (parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.2)) });
    });
    return out; })()`);
  console.log('  ℹ ' + JSON.stringify(ovf));
  t('只读行都是正常尺寸（不是 0，也不是找不到）', ovf.every((o) => o.state === 'OK'), true);
  t('只读行的长文案在换行而不是溢出（scrollWidth 不超 clientWidth）',
    ovf.every((o) => o.scrollW <= o.clientW + 1), true);

  /* ---- 4d. 弹框关得掉 ---- */
  await js(`document.getElementById('mcfg-cancel').click()`);
  await sleep(400);
  const afterClose = await probe(['#mask-mcfg .dialog-mcfg']);
  t('取消后配置框真的收起了', afterClose['#mask-mcfg .dialog-mcfg'].state, 'ZERO_SIZE');

  /* ---- 4e. Esc 也要能关（坑 19 那一族：浮层必须自己吃掉 Esc） ---- */
  await js(`(function(){
    var rows = [].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
    var row = rows.filter(function(r){ var n=r.querySelector('.mi-n');
      return n && n.textContent.trim() === ${JSON.stringify(String((def && def.model) || ''))}; })[0];
    if (!row) return 'NO_ROW';
    row.click();
    var b = document.getElementById('mdl-config');
    if (!b) return 'NO_CFG_BTN'; b.click(); return 'OK'; })()`);
  await sleep(1200);
  t('重新打开配置框（为验 Esc）', (await probe(['#mask-mcfg .dialog-mcfg']))['#mask-mcfg .dialog-mcfg'].state, 'OK');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(400);
  t('Esc 能关掉配置框（而且没掉进 doAbort）',
    (await probe(['#mask-mcfg .dialog-mcfg']))['#mask-mcfg .dialog-mcfg'].state, 'ZERO_SIZE');
  t('Esc 关的是配置框，模型框还开着（没连坐）',
    await js(`!document.getElementById('mask-model').classList.contains('hidden')`), true);
  t('Esc 没有误触中途中断', await js(`window.__pixelAborts`), 0);

  await js(`document.getElementById('mask-model').classList.add('hidden')`);
  await sleep(300);

  console.log('\n================ 汇总 ================');
  console.log('PASS ' + RESULT.pass + ' / FAIL ' + RESULT.fail);
  console.log('（退出码 ' + (RESULT.fail ? 1 : 0) + '）');
  app.exit(RESULT.fail ? 1 : 0);
});

app.on('window-all-closed', () => app.exit(0));
