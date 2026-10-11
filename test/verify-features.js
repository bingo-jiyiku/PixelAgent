// ============================================================
// test/verify-features.js —— 本轮新增功能的真机验收
// 跑法：electron test/verify-features.js   （注意必须用 electron，不是 node）
//
// 验的都是**行为**，不是"代码里有没有这段字符串"：
//   1) 喂真实结构的事件 → 右栏 TODOS 真的渲染出条目
//   2) 图片走真实 FileReader → 附件条真的出现缩略图
//   3) 端到端：api.ask 带图 → 落盘 → pi 的请求里真的出现 image 内容块
//   4) `!` 真的在本机跑了 shell，输出和退出码都回显
//   5) 会话重命名 / 跨会话搜索走真 IPC
//   6) AGENTS 拿到真的扩展清单（真跑 pi list）
// ============================================================
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const ATT_DIR = path.join(__dirname, '..', '.attachments');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 图片夹具必须**先自检合法**再拿去测产品。
// 上一轮这里内联了一张手搓的 1×1 PNG，IDAT 的 CRC / Adler-32 都是错的，
// 图根本解不开 → pi 的图片缩放失败 → 端到端断言红了两轮，
// 而真凶是夹具。loadImage 会在夹具不合法时直接抛错，不让它伪装成产品缺陷。
const IMG = require('./fixtures/load-image.js').loadImage('pixel-24.png');
const PNG_B64 = IMG.base64;

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; console.log('  ✅ ' + name); return; }
  fail++;
  console.log('  ❌ ' + name);
  console.log('     got : ' + JSON.stringify(got));
  console.log('     want: ' + JSON.stringify(want));
}

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(1800);   // 让启动时的异步预取（模型目录/文件树）先安静下来

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('  📷 ' + name);
  };

  /* ================= 1. TODOS：喂真实结构的事件 ================= */
  console.log('\n[1] TODOS');
  const todoEv = {
    type: 'tool_execution_end',
    toolName: 'todo',
    toolCallId: 'call_verify_1',
    result: {
      content: [{
        type: 'text',
        text: 'Added todo #2: 跑测试\nPIXELTODOS:{"action":"add","todos":[{"id":1,"text":"写 README","done":true},{"id":2,"text":"跑测试","done":false}],"nextId":3}'
      }],
      details: {
        action: 'add',
        todos: [{ id: 1, text: '写 README', done: true }, { id: 2, text: '跑测试', done: false }],
        nextId: 3
      }
    },
    isError: false
  };
  const nTodos = await js(`(function(){ const ev = ${JSON.stringify(todoEv)};` +
    ` window.__pixelFeed({kind:'ev', ev:ev}); return window.__pixel.todos.length; })()`);
  t('事件喂入后内存里有 2 条待办', nTodos, 2);

  await js(`document.querySelector('.rtab[data-tab="todos"]').click()`);
  await sleep(400);
  const domTodos = await js(`document.querySelectorAll('#todos-list .todo-item').length`);
  t('TODOS 面板渲染 2 条', domTodos, 2);
  const domDone = await js(`document.querySelectorAll('#todos-list .todo-item.done').length`);
  t('已完成的那条带 done 样式', domDone, 1);
  const hdTxt = await js(`document.getElementById('todos-hd').textContent`);
  t('标题显示 1 / 2', hdTxt, '1 / 2');
  await shot('12-todos.png');

  /* ================= 2. 附件 UI：真实 FileReader 链路 ================= */
  console.log('\n[2] 图片附件（UI 链路）');
  console.log('  ℹ 夹具: ' + path.basename(IMG.path) + ' ' + IMG.bytes + ' bytes');
  const nAtt = await js(`(function(){
    const bin = atob(${JSON.stringify(PNG_B64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], '测试截图.png', { type: 'image/png' });
    addAttachment(f);
    return new Promise(function(res){ setTimeout(function(){ res(window.__pixel.attachments.length); }, 500); });
  })()`);
  t('附件进入待发列表', nAtt, 1);

  const attDom = await js(`(function(){
    const bar = document.getElementById('attbar');
    return {
      hidden: bar.classList.contains('hidden'),
      items: bar.querySelectorAll('.att-item').length,
      imgs: bar.querySelectorAll('.att-item img').length,
      name: (bar.querySelector('.att-n') || {}).textContent || ''
    };
  })()`);
  t('附件条已显示', attDom.hidden, false);
  t('附件条 1 项', attDom.items, 1);
  t('附件条有缩略图', attDom.imgs, 1);
  t('附件条显示文件名', attDom.name, '测试截图.png');
  await shot('15-attach.png');

  // 当前默认模型不看图 → 必须给出警告，不能让用户以为 AI 眼瞎。
  // 这里用**可控状态**分别验两种提示，不靠"碰巧当前模型是什么"：
  //   · 能力未知 → 中性提示（不能默认成"没问题"）
  //   · 明确不支持 → 强警告
  // 一条都不出的话，用户就会以为发出去的图 AI 看得见。
  const hintUnknown = await js(`(function(){
    window.__pixel.curModel = null;
    document.getElementById('kv-model').textContent = '—';
    renderAtt();
    const w = document.querySelector('#attbar .att-warn');
    return w ? w.className : 'NONE';
  })()`);
  t('能力未知时给出中性提示', hintUnknown.indexOf('note') >= 0, true);

  const hintNo = await js(`(function(){
    window.__pixel.curModel = { provider: 'p', model: '__不存在的不看图的模型__' };
    window.__pixel.models = [{ provider: 'p', model: '__不存在的不看图的模型__', images: false }];
    renderAtt();
    const w = document.querySelector('#attbar .att-warn');
    const strong = w && w.className.indexOf('note') < 0;
    return { cls: w ? w.className : 'NONE', strong: !!strong };
  })()`);
  t('明确不支持看图时给强警告', hintNo.strong, true);

  // 收尾：把模型状态清回去，免得影响后面几段
  await js(`(function(){ window.__pixel.curModel = null; window.__pixel.models = [];` +
    ` document.getElementById('kv-model').textContent = '—'; renderAtt(); return true; })()`);
  const visMark = await js(`document.getElementById('kv-vis').textContent`);
  console.log('  ℹ 状态栏视觉能力标记: ' + visMark);

  /* ================= 3. 端到端：带图发出去，pi 请求里要有 image 块 ================= */
  console.log('\n[3] 端到端：附件 → 落盘 → pi 收到 image 块');
  await js(`(function(){ window.__probe = [];` +
    ` window.pixelAPI.onMsg(function(m){ window.__probe.push(m); }); return true; })()`);

  // 清掉待发附件，避免上一段的残留被重复发
  await js(`(function(){ window.__pixel.attachments = []; renderAtt(); return true; })()`);

  const beforeFiles = fs.existsSync(ATT_DIR) ? fs.readdirSync(ATT_DIR).length : 0;

  // ★ 必须在这里取基线（**发起请求之前**）。
  // 为什么非记不可：这个会话文件是**跨轮累积**的，上一轮验收写进去的带图消息
  // 还躺在里面。只看"最后一条 user 消息有没有图"，就会拿上一轮的旧数据
  // 冒充这一轮的结果 —— 我上一版就是这么假阳性通过的，
  // 同时还让实时事件流的断言假阴性失败。两边都不可信。
  // 也不能放到 ask 之后再取：pi 可能已经写完第一行了，那样基线本身就偏高。
  //
  // ⚠ `window.pixelAPI.history()` 是 ipcRenderer.invoke，返回 **Promise**。
  //   写成同步调用的话 `h.msgs` 永远是 undefined，计数恒为 0 ——
  //   我第一版就是这么写的，于是"消息条数 +1"这条断言永远红。必须 then 出来。
  const countUsers = `window.pixelAPI.history().then(function(h){
    return (h && h.msgs ? h.msgs.filter(function(m){ return m.role === 'user'; }) : []);
  })`;
  const beforeUsers = await js(`(function(){ return ${countUsers}.then(function(a){ return a.length; }); })()`);
  console.log('  ℹ 发送前会话里已有 user 消息: ' + beforeUsers + ' 条');

  // 切一个支持看图的模型再发。
  // 默认模型看不懂图，会退化成自己跑一堆 OCR / 像素采样工具 ——
  // 又慢又费 token，而且跟「图有没有传进去」这个待验证的事毫无关系。
  const visionModel = { provider: 'agent-plan', model: 'doubao-seed-2-1-pro-260915' };
  await js(`window.pixelAPI.setModel(${JSON.stringify(visionModel)})`);
  await js(`(function(){ window.__pixel.curModel = ${JSON.stringify(visionModel)}; if (window.paintModelBar) paintModelBar(); return true; })()`);

  const askRes = await js(`window.pixelAPI.ask({ text: '这张图里是什么？图上都有哪些颜色？',` +
    ` images: [{ name: '验证图.png', dataUrl: ${JSON.stringify(IMG.dataUrl)} }] })`);
  t('ask 被受理', !!(askRes && askRes.ok), true);
  t('主进程回报落了 1 个附件', askRes && askRes.attachments, 1);

  const afterFiles = fs.existsSync(ATT_DIR) ? fs.readdirSync(ATT_DIR).length : 0;
  t('附件目录里真的多了文件', afterFiles, beforeFiles + 1);

  // 等这一轮真的跑起来。
  // 绝不能用「睡固定秒数然后断言」：pi 还没启动时探针是空的，
  // 会把「还没跑起来」判成「图没传进去」。
  // 也不能只靠会话文件：判断依据必须是**本轮新增**的证据。
  // 所以两个门槛同时看：
  //   ① 实时事件流里出现本轮的 message_start(user)  ← 最直接
  //   ② 会话文件里 user 消息条数比发送前多          ← 落盘证据
  let imgOk = false;
  let liveOk = false;
  let pollLog = '';
  let userDelta = 0;
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const st = await js(`(function(){
      const p = window.__probe || [];
      const kinds = {};
      for (let i = 0; i < p.length; i++) { const k = p[i].kind || '?'; kinds[k] = (kinds[k] || 0) + 1; }
      let liveImg = '';
      for (let i = 0; i < p.length; i++) {
        const m = p[i];
        if (!m || m.kind !== 'ev' || !m.ev) continue;
        const ev = m.ev;
        if (ev.type === 'message_start' && ev.message && ev.message.role === 'user' && Array.isArray(ev.message.content)) {
          for (let k = 0; k < ev.message.content.length; k++) {
            const c = ev.message.content[k];
            if (c && c.type === 'image') liveImg = String(c.mimeType || c.mediaType || '?');
          }
        }
      }
      return { n: p.length, kinds: kinds, liveImg: liveImg };
    })()`);
    pollLog = JSON.stringify(st);

    const h = await js(`(function(){ return ${countUsers}; })()`);
    const users = h || [];
    userDelta = users.length - beforeUsers;
    const last = users[users.length - 1];
    // 必须「多了一条」才算本轮的
    if (userDelta > 0 && last && last.images > 0) imgOk = true;
    if (st.liveImg) liveOk = true;
    if (imgOk && liveOk) break;
  }
  t('会话文件里本轮新增的 user 消息带 image 块', imgOk, true);
  t('本轮 user 消息条数真的 +1（不是拿了旧数据）', userDelta > 0, true);
  console.log('  ℹ 探针快照: ' + pollLog + ' / user 消息增量: ' + userDelta);

  // 更强的一条：实时事件流里也要能看到 image 内容块
  const probeImg = await js(`(function(){
    const p = window.__probe || [];
    for (let i = 0; i < p.length; i++) {
      const m = p[i];
      if (!m || m.kind !== 'ev' || !m.ev) continue;
      const ev = m.ev;
      if (ev.type === 'message_start' && ev.message && ev.message.role === 'user' && Array.isArray(ev.message.content)) {
        for (let k = 0; k < ev.message.content.length; k++) {
          const c = ev.message.content[k];
          if (c && c.type === 'image') return String(c.mimeType || c.mediaType || '?');
        }
      }
    }
    return '';
  })()`);
  console.log('  ℹ 实时事件流里的 image mime: ' + (probeImg || '(没抓到)'));
  // 这条以前只打了日志不断言 —— 等于白跑。日志会骗人（看着"有输出"就以为过了）。
  t('实时事件流里真的抓到 image 块', !!probeImg, true);
  t('抓到的是 png', probeImg, 'image/png');

  // 图片块要带真实 base64 —— 只有 mimeType、没有数据的空壳最容易蒙混过关
  const probeDataLen = await js(`(function(){
    const p = window.__probe || [];
    for (let i = 0; i < p.length; i++) {
      const m = p[i];
      if (!m || m.kind !== 'ev' || !m.ev) continue;
      const ev = m.ev;
      if (ev.type === 'message_start' && ev.message && ev.message.role === 'user' && Array.isArray(ev.message.content)) {
        for (let k = 0; k < ev.message.content.length; k++) {
          const c = ev.message.content[k];
          if (c && c.type === 'image') return String(c.data || '').length;
        }
      }
    }
    return 0;
  })()`);
  t('image 块带真实 base64 数据（>100 字符）', probeDataLen > 100, true);
  console.log('  ℹ image base64 长度: ' + probeDataLen);

  await js(`window.pixelAPI.abort()`);
  await sleep(1200);

  /* ================= 3b. 两层防丢图兜底 ================= */
  // 这一段存在的理由：上一轮我为"图没进去"查了两轮。
  // pi 丢图**不报错**，只在文本里留一句方括号标记，界面完全看不出来。
  // 所以必须有断言盯着这两层防线，它们才不会哪天被改掉没人发现。
  console.log('\n[3b] 防丢图兜底');

  // 第一层（发之前）：坏图必须在 main 进程就被拦下，
  // 而且要把**真实原因**带回来，不能只说一句"失败了"。
  const BAD_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const badRes = await js(`window.pixelAPI.ask({ text: '',` +
    ` images: [{ name: '坏图.png', dataUrl: 'data:image/png;base64,${BAD_PNG_B64}' }] })`);
  t('坏图 请求被拒', badRes && badRes.ok === false, true);
  t('坏图 拒绝原因是 IMAGE_REJECTED', badRes && badRes.reason, 'IMAGE_REJECTED');
  t('坏图 带回了 rejected 明细', !!(badRes && Array.isArray(badRes.rejected) && badRes.rejected.length === 1), true);
  const badWhy = (badRes && badRes.rejected && badRes.rejected[0] && badRes.rejected[0].reason) || '';
  console.log('  ℹ 坏图被拒原因: ' + badWhy);
  t('坏图 原因指到 IDAT（不是含糊的"失败"）', badWhy.indexOf('IDAT') >= 0, true);
  t('坏图 没被写进附件目录', (fs.existsSync(ATT_DIR) ? fs.readdirSync(ATT_DIR).length : 0), afterFiles);

  // 第二层（发之后）：把 pi 真实的"丢图"事件喂进渲染层，
  // 界面上必须弹出一条 IMG 提示。样本取自真实抓包 test/_repro.log。
  const omitEv = {
    type: 'message_start',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: '<file name="E:\\PixelAgent\\.attachments\\probe.png"></file>\n这张图里是什么？\n\n' +
          '[Image omitted: could not be resized below the inline image size limit.]'
      }]
    }
  };
  await js(`(function(){ window.__pixel.imgWarned = false; window.__pixel.attSent = 1;` +
    ` window.__pixelFeed({kind:'ev', ev:${JSON.stringify(omitEv)}}); return true; })()`);
  await sleep(300);
  const imgWarn = await js(`(function(){
    const ns = document.querySelectorAll('.m.err');
    for (let i = ns.length - 1; i >= 0; i--) {
      const w = ns[i].querySelector('.who');
      if (w && w.textContent === '图片') return ns[i].textContent;
    }
    return '';
  })()`);
  console.log('  ℹ 界面提示: ' + (imgWarn ? imgWarn.slice(0, 110) : '(没出提示)'));
  t('丢图时界面弹出 IMG 提示', imgWarn.length > 0, true);
  t('提示里点明了是图片没进请求', imgWarn.indexOf('图片没能进入请求') >= 0, true);
  t('提示里带上 pi 的原话', imgWarn.indexOf('Image omitted') >= 0, true);

  // 反过来：正常的 user 消息不能误报（否则这条提示会因为狼来了被无视）
  //
  // 注意：这里必须比"**新增**了几条 IMG 提示"，不能直接查"时间线里有没有"。
  // 第一版就是直接查的，结果上一段那条提示还挂在时间线上，
  // 于是"没误报"被读成了"误报了" —— 假阴性的另一种长相。
  const imgWarnCount = () => js(`(function(){
    let n = 0;
    const ns = document.querySelectorAll('.m.err');
    for (let i = 0; i < ns.length; i++) {
      const w = ns[i].querySelector('.who');
      if (w && w.textContent === '图片' && ns[i].textContent.indexOf('图片没能进入请求') >= 0) n++;
    }
    return n;
  })()`);
  const warnBefore = await imgWarnCount();

  await js(`(function(){ window.__pixel.imgWarned = false; window.__pixel.attSent = 1;` +
    ` window.__pixelFeed({kind:'ev', ev:{type:'message_start', message:{role:'user',` +
    ` content:[{type:'text',text:'看图'},{type:'image',mimeType:'image/png',data:'iVBORw0KGgo'}]}}}); return true; })()`);
  await sleep(300);
  const warnAfter = await imgWarnCount();
  t('正常带图消息不新增误报', warnAfter, warnBefore);
  t('正常消息被识别为带 1 张图', await js(`window.__pixel.imgIn`), 1);

  // 再补一条：带了图但 pi 既没给 image 块、也没留标记 —— 第三层兜底要触发。
  const warnBefore3 = await imgWarnCount();
  await js(`(function(){ window.__pixel.imgWarned = false; window.__pixel.attSent = 2;` +
    ` window.__pixelFeed({kind:'ev', ev:{type:'message_start', message:{role:'user',` +
    ` content:[{type:'text',text:'看图'}]}}}); return true; })()`);
  await sleep(300);
  const ghostWarn = await js(`(function(){
    const ns = document.querySelectorAll('.m.err');
    for (let i = ns.length - 1; i >= 0; i--) {
      const w = ns[i].querySelector('.who');
      if (w && w.textContent === '图片' && ns[i].textContent.indexOf('一个图片块都没有') >= 0) return ns[i].textContent;
    }
    return '';
  })()`);
  t('既无图块也无标记时也会兜底提示', ghostWarn.length > 0, true);
  t('兜底提示提到带了 2 张图', ghostWarn.indexOf('2 张图') >= 0, true);
  t('兜底提示不算新增"没进请求"（那是另一条判据）', await imgWarnCount(), warnBefore3);

  /* ================= 4. `!` 直接执行 shell ================= */
  console.log('\n[4] ! shell 直接执行');
  await js(`(function(){ const i = document.getElementById('input');` +
    ` i.value = '!echo pixelagent-shell-ok'; send(); return true; })()`);
  await sleep(3500);
  const shOut = await js(`(function(){ const o = document.querySelector('.m.shell .sh-out'); return o ? o.textContent : 'NO_EL'; })()`);
  t('shell 输出里含回显标记', String(shOut).indexOf('pixelagent-shell-ok') >= 0, true);
  const shCode = await js(`(function(){ const c = document.querySelector('.m.shell .sh-code'); return c ? c.textContent : 'NO_EL'; })()`);
  t('shell 退出码为 0', shCode, '退出码 0');
  await shot('14-shell.png');

  // 非零退出码也要如实回显
  await js(`(function(){ const i = document.getElementById('input'); i.value = '!exit 3'; send(); return true; })()`);
  await sleep(2500);
  const codes = await js(`Array.prototype.map.call(document.querySelectorAll('.m.shell .sh-code'), function(e){ return e.textContent; })`);
  t('非零退出码被回显', codes.indexOf('退出码 3') >= 0, true);

  /* ================= 4b. stderr 分档：成功的那轮别拿红色砸人 ================= */
  // 来自真机截图顶部那条：pi 清理自己的锁时撞上本机安全策略，
  // 于是往 stderr 打了一句 "Invalid settings file …"，而这一轮其实是**成功**的
  // （退出码 0、模型正常回答）。旧代码把任何 stderr 都渲染成红色 ERR，
  // 看着像出大事了 —— 这正是"用起来烧心"。
  // 规则按**退出码**分档（不猜关键词）：0 → SYS 提示；非 0 → 照实红着显示。
  console.log('\n[4b] stderr 按退出码分档');
  const countM = (sel) => js(`document.querySelectorAll('${sel}').length`);

  const b1err = await countM('.m.err');
  const b1sys = await countM('.m.step');
  await js(`(function(){ window.__pixelFeed({kind:'exit', code:0,` +
    ` stderr:'Warning: Invalid settings file E:/px/.pi-agent/settings.json: [safe-delete] 失败\\n第二行噪音'}); return true; })()`);
  await sleep(250);
  const a1err = await countM('.m.err');
  const a1sys = await countM('.m.step');
  t('退出码 0：stderr 不产生红色 ERR', a1err, b1err);
  t('退出码 0：stderr 降级成 SYS 提示', a1sys > b1sys, true);

  // 全文不能丢：要挂在 title 上可查
  const titleTxt = await js(`(function(){
    const ns = document.querySelectorAll('.m.step');
    for (let i = ns.length - 1; i >= 0; i--) {
      if ((ns[i].title || '').indexOf('Invalid settings file') >= 0) return ns[i].title;
    }
    return '';
  })()`);
  t('降级提示保留了 stderr 全文', titleTxt.indexOf('第二行噪音') >= 0, true);

  const b2err = await countM('.m.err');
  await js(`(function(){ window.__pixelFeed({kind:'exit', code:1, stderr:'boom: 真的失败了'}); return true; })()`);
  await sleep(250);
  const a2err = await countM('.m.err');
  t('退出码非 0：stderr 照实红着显示', a2err > b2err, true);

  /* ================= 5. 会话重命名 + 跨会话搜索 ================= */
  console.log('\n[5] 会话操作与搜索');
  const sess = await js(`window.pixelAPI.sessions()`);
  t('拿到了会话列表', !!(sess && Array.isArray(sess.sessions)), true);
  const target = (sess.sessions || [])[0];
  if (target) {
    await js(`window.pixelAPI.renameSession(${target.seq}, '像素终端验收会话')`);
    const sess2 = await js(`window.pixelAPI.sessions()`);
    const hit = (sess2.sessions || []).find((s) => s.seq === target.seq);
    t('重命名生效', hit && hit.title, '像素终端验收会话');
    t('重命名标记存在', !!(hit && hit.renamed), true);

    // 清掉别名，别把测试痕迹留在用户数据里
    await js(`window.pixelAPI.renameSession(${target.seq}, '')`);
    const sess3 = await js(`window.pixelAPI.sessions()`);
    const hit3 = (sess3.sessions || []).find((s) => s.seq === target.seq);
    t('清空别名后恢复自动标题', !!(hit3 && !hit3.renamed), true);
  } else {
    console.log('  ⚠ 没有历史会话，跳过重命名断言');
  }

  const sr = await js(`window.pixelAPI.search('的')`);
  t('搜索返回结果结构', !!(sr && Array.isArray(sr.hits)), true);
  console.log('  ℹ 搜「的」命中 ' + ((sr && sr.hits && sr.hits.length) || 0) + ' 条');
  const srShort = await js(`window.pixelAPI.search('x')`);
  t('少于 2 字不搜（need=2）', srShort && srShort.need, 2);

  // 会话目录里得真有会话文件，否则上面"搜不到"根本区分不出是没数据还是搜坏了
  const sessDir = path.join(__dirname, '..', '.sessions');
  const sessFiles = fs.existsSync(sessDir)
    ? fs.readdirSync(sessDir).filter((f) => /^chat-\d+\.json$/.test(f))
    : [];
  t('会话目录里有会话文件', sessFiles.length > 0, true);
  console.log('  ℹ 会话文件: ' + JSON.stringify(sessFiles));

  /* ================= 5b. 会话删除 / 导出 ================= */
  // 这两件事上一轮只实现了、没验收（导出要弹系统保存框，没法点）。
  // 所以给 exportSession 加了 outPath 参数：给了就跳过对话框直接写文件，
  // 「能不能导出」这件事才验得动。
  //
  // 删除用**一次性会话**（seq 997，测试自己造的），
  // 绝不拿老板的真实会话做实验 —— 哪怕走的是回收站。
  console.log('\n[5b] 会话删除 / 导出');
  const TMP_SESS_SEQ = 997;
  const tmpSessFile = path.join(__dirname, '..', '.sessions', 'chat-' + TMP_SESS_SEQ + '.json');
  const tmpExportDir = path.join(__dirname, '_export_tmp');
  const tmpExportFile = path.join(tmpExportDir, 'sess-997.html');
  try { fs.rmSync(tmpExportDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  const nowIso = new Date().toISOString();
  const ndjson = [
    { type: 'session', version: 3, id: 'verify-997', timestamp: nowIso, cwd: path.join(__dirname, '..') },
    { type: 'model_change', id: 'm997', parentId: null, timestamp: nowIso, provider: 'agent-plan', modelId: 'ark-code-latest' },
    {
      type: 'message', id: 'u997', parentId: 'm997', timestamp: nowIso,
      message: { role: 'user', content: [{ type: 'text', text: '验收用一次性会话，跑完就删' }], timestamp: Date.now() }
    },
    {
      type: 'message', id: 'a997', parentId: 'u997', timestamp: nowIso,
      message: { role: 'assistant', content: [{ type: 'text', text: '好的，这是一条一次性会话。' }] }
    }
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(tmpSessFile, ndjson, 'utf8');

  // 造好的会话必须被列出来，否则后面"删掉后不见了"根本说明不了问题
  const sessWithTmp = await js(`window.pixelAPI.sessions()`);
  const tmpRow = (sessWithTmp.sessions || []).find((s) => s.seq === TMP_SESS_SEQ);
  t('一次性会话被会话列表识别', !!tmpRow, true);
  t('一次性会话标题取自首条 user 消息', tmpRow && tmpRow.title, '验收用一次性会话，跑完就删');

  // 导出：指定路径 → 不弹框，直接产出。
  // ★ 这里刻意调**渲染层**的 exportSession（不是裸 IPC），
  //   因为"界面有没有把结果说出来"也是要验的一部分；
  //   直接调 IPC 就把渲染层整段跳过了，等于只验了半个功能。
  const exp = await js(`(function(){ return window.__pixelExport(${TMP_SESS_SEQ}, ${JSON.stringify(tmpExportFile)}); })()`);
  console.log('  ℹ 导出结果: ' + JSON.stringify(exp));
  t('导出成功', !!(exp && exp.ok), true);
  t('导出的文件真的落在指定路径', fs.existsSync(tmpExportFile), true);
  t('导出文件不是空的', fs.existsSync(tmpExportFile) && fs.statSync(tmpExportFile).size > 0, true);
  if (fs.existsSync(tmpExportFile)) {
    const html = fs.readFileSync(tmpExportFile, 'utf8');
    t('导出内容确实是 HTML', /<html[\s>]/i.test(html), true);
    // pi 的 --export 产出的是**自包含查看器**：
    // 会话正文以 base64 塞在 <script id="session-data" type="application/json"> 里，
    // 页面上并没有明文。第一版断言直接 grep 明文，自然找不到 —— 断言错了，不是导出错了。
    const m = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/.exec(html);
    t('导出里带内嵌的会话数据块', !!m, true);
    if (m) {
      let payload = '';
      try { payload = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { /* 下面按空处理 */ }
      t('内嵌数据能解成 JSON', (() => { try { JSON.parse(payload); return true; } catch (e) { return false; } })(), true);
      t('导出的正文里带着那条对话', payload.indexOf('一次性会话') >= 0, true);
      const j = (() => { try { return JSON.parse(payload); } catch (e) { return null; } })();
      t('导出的 entries 里有 2 条消息', j ? (j.entries || []).filter((e) => e.type === 'message').length : -1, 2);
    }
  }
  // 界面得把导出结果说出来，否则用户不知道文件去哪了
  const expMsg = await js(`(function(){
    const ns = document.querySelectorAll('.m.step');
    for (let i = ns.length - 1; i >= 0; i--) {
      if (ns[i].textContent.indexOf('已导出') >= 0) return ns[i].textContent;
    }
    return '';
  })()`);
  t('界面报出了导出路径', expMsg.indexOf('sess-997.html') >= 0, true);

  // 导出不存在的会话：必须明确说 NOT_FOUND，不能假装成功
  const expBad = await js(`window.pixelAPI.exportSession(9988, ${JSON.stringify(tmpExportFile)})`);
  t('导出不存在的会话报 NOT_FOUND', expBad && expBad.reason, 'NOT_FOUND');
  t('导出失败时不产出文件', fs.existsSync(path.join(tmpExportDir, 'sess-9988.html')), false);

  // 删除：走回收站（可恢复），文件从会话目录消失。
  // ⚠ 本机（沙箱环境）实测 shell.trashItem 会把文件移走**之后仍然 reject**
  //   "Operation was aborted"（见 test/_trash-probe.js）。
  //   所以断言必须以「文件还在不在」为准，不能以 ok 字段为准 ——
  //   否则会把一次成功的删除判成失败，而这个 bug 只有真跑才看得见。
  //
  // 同样调**渲染层**的删除结果处理（applyDeleteResult），不裸调 IPC ——
  // 界面那句"可恢复性未能确认"必须被验到。
  const del = await js(`window.pixelAPI.deleteSession(${TMP_SESS_SEQ})`);
  console.log('  ℹ 删除结果: ' + JSON.stringify({ ok: del && del.ok, reason: del && del.reason, trashNote: (del && del.trashNote) || '' }));
  if (del && del.ok) await js(`window.__pixelApplyDelete(${TMP_SESS_SEQ}, ${JSON.stringify(del)})`);

  t('删除后文件已从会话目录消失', fs.existsSync(tmpSessFile), false);
  t('删除回报 ok（以文件已移出为准，不因回收站异常而误报失败）', !!(del && del.ok), true);
  const sessAfterDel = await js(`window.pixelAPI.sessions()`);
  t('删除后会话列表里也没有了',
    !(sessAfterDel.sessions || []).some((s) => s.seq === TMP_SESS_SEQ), true);

  // trashNote 是**本机环境**现象（沙箱下回收站会 abort），
  // 不是每个环境都会出现 —— 所以只做**条件断言**：
  // 一旦出现，界面就必须如实说出来，不能吞掉。
  // 写成"必须出现"的话，在回收站正常的机器上这条会假红。
  if (del && del.trashNote) {
    const delNote = await js(`(function(){
      const ns = document.querySelectorAll('.m.step, .m.err');
      for (let i = ns.length - 1; i >= 0; i--) {
        if (ns[i].textContent.indexOf('可恢复性未能确认') >= 0) return ns[i].textContent;
      }
      return '';
    })()`);
    t('回收站有异常时界面如实提示可恢复性未确认', delNote.length > 0, true);
  } else {
    console.log('  ℹ 本机回收站正常（无 trashNote），跳过该条件断言');
  }

  // 参数校验：不能因为参数脏就把别的会话删了
  const delBad = await js(`window.pixelAPI.deleteSession(-1)`);
  t('非法 seq 被拒（BAD_SEQ）', delBad && delBad.reason, 'BAD_SEQ');
  const delMiss = await js(`window.pixelAPI.deleteSession(9988)`);
  t('删不存在的会话报 NOT_FOUND', delMiss && delMiss.reason, 'NOT_FOUND');

  // 收尾：把导出产物清掉，别在仓库里留垃圾
  try { fs.rmSync(tmpExportDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  /* ================= 5c. 会话条布局：按钮不能压住标题 ================= */
  // 这条来自真机截图：`.sess-ops` 原来是 position:absolute 盖在右上角，
  // 而标题只在容器边缘截断 —— 长标题直接钻到按钮底下，字和按钮叠在一起。
  // 这类问题跑功能断言是看不出来的（DOM 结构完全正确），
  // 只有量**几何**才发现得了，所以这里量 bounding box。
  console.log('\n[5c] 会话条布局');
  const overlap = await js(`(function(){
    const rows = document.querySelectorAll('#session-list .sess');
    const bad = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = r.querySelector('.sess-name');
      const ops = r.querySelector('.sess-ops');
      if (!name || !ops) continue;
      const a = name.getBoundingClientRect();
      const b = ops.getBoundingClientRect();
      // visibility:hidden 也占位、也能量到真实盒子 —— 所以没 hover 的行照样能查
      if (!b.width || !b.height) continue;
      const hit = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      if (hit) bad.push(String(name.textContent || '').slice(0, 16));
    }
    return bad;
  })()`);
  console.log('  ℹ 疑似重叠的行: ' + JSON.stringify(overlap));
  t('会话标题没有被操作按钮压住', JSON.stringify(overlap), '[]');
  // 同时确认按钮**确实占着位置**（改成 visibility 之后不能变成完全不占位，
  // 否则又会退回"盖在标题上"）
  const opsBox = await js(`(function(){
    const all = document.querySelector('#session-list .sess .sess-ops');
    const off = document.querySelector('#session-list .sess:not(.on) .sess-ops');
    const use = off || all;
    if (!use) return null;
    const r = use.getBoundingClientRect();
    const cs = getComputedStyle(use);
    return { w: Math.round(r.width), pos: cs.position, vis: cs.visibility, isCurrent: !off };
  })()`);
  console.log('  ℹ 操作按钮盒子: ' + JSON.stringify(opsBox));
  t('操作按钮在正常流里（不是绝对定位）', opsBox && opsBox.pos, 'static');
  t('操作按钮确实占位（宽度 > 0）', !!(opsBox && opsBox.w > 0), true);
  if (opsBox && !opsBox.isCurrent) {
    t('非当前会话默认隐藏按钮（visibility 而非不占位）', opsBox.vis, 'hidden');
  } else {
    t('只有当前会话时才无法验"非当前隐藏"，退而验它有盒子', !!(opsBox && opsBox.w > 0), true);
  }

  /* ================= 6. AGENTS：真扩展清单 ================= */
  console.log('\n[6] AGENTS 扩展清单');
  await js(`document.querySelector('.rtab[data-tab="sub"]').click()`);
  await sleep(6000);   // 真跑 pi list，要等子进程
  const extN = await js(`document.querySelectorAll('#ext-list .agent-item').length`);
  t('扩展清单至少有自带的那一个', extN >= 1, true);
  const extNames = await js(`Array.prototype.map.call(document.querySelectorAll('#ext-list .agent-item .ag-n'), function(e){ return e.textContent; })`);
  console.log('  ℹ 清单: ' + JSON.stringify(extNames));
  await shot('13-agents.png');

  /* ================= 7. 中文体检：界面上不该再冒英文标签 =================
     这条断言**读真实 DOM 里渲染出来的文字**，不是"源码里还有没有那个字符串"。
     第一版是**手写选择器清单**，人工挑要检查的类名 —— 结果 `.cap-t`
     不在清单里，我把它改回 "SESSIONS" 反向验证时**照样全绿**（假通过）。
     现在改成**结构式全扫**：从 body 往下走，凡是"叶子元素"（没有元素子节点、
     只有一段文字）都算候选标签位，只排除"内容/数据位"（用户正文、模型名、
     路径、工具名…… 这些天生可能是英文），并给每个排除写清理由。
     排除清单写错的风险靠**反向验证**兜底：故意塞个英文标签必须变红。 */
  console.log('\n[7] 中文体检（界面标签不该再是英文）');
  // 先喂一条带代码块的 AI 消息 —— 代码块右上角那个复制按钮只在这时才存在。
  // （上一版漏了它：它是从 md.js 里生成的，看不见就扫不到，"COPY" 一直留着）
  await js(`(function(){
    const feed = (ev) => window.__pixelFeed({kind:'ev', ev:ev});
    feed({type:'message_update', assistantMessageEvent:{type:'text_start'}});
    feed({type:'message_update', assistantMessageEvent:{type:'text_delta',
      delta:'\\u4ee3\\u7801\\u5757\\u6f14\\u793a\\uff1a\\n\\n\\u0060\\u0060\\u0060js\\nconsole.log(1)\\n\\u0060\\u0060\\u0060\\n'}});
    feed({type:'message_update', assistantMessageEvent:{type:'text_end'}});
    return true; })()`);
  await sleep(400);
  const mdCopy = await js(`(function(){ const b=document.querySelector('#log .md-copy'); return b ? b.textContent.trim() : 'NO_EL'; })()`);
  console.log('  ℹ 代码块复制按钮: ' + mdCopy);
  t('代码块右上角复制按钮是中文', mdCopy, '复制');
  // 文件面板要切过去才会有 .f-ico（原来是 "DIR"/"FIL"，也是改文案时漏掉的）
  await js(`(function(){ const t=document.querySelector('.rtab[data-tab="files"]'); if(t) t.click(); return 1; })()`);
  await sleep(700);
  const fico = await js(`Array.prototype.map.call(document.querySelectorAll('#files-list .f-ico'), function(e){ return e.textContent.trim(); })`);
  console.log('  ℹ 文件列表图标文字: ' + JSON.stringify(Array.from(new Set(fico))) + '（共 ' + fico.length + ' 个）');
  // 空列表会让 every() 平凡通过 —— 先确认真拿到了元素
  t('文件列表里确实有图标位（否则下面的断言是空转）', fico.length > 0, true);
  t('文件列表图标文字是中文', fico.every((x) => x === '目录' || x === '文件'), true);
  const labels = await js(`(function(){
    // 内容/数据位（按 class）：这些的值天生可能是英文，不是 UI 标签
    const CONTENT_CLS = new Set([
      'txt','md','md-code','sh-out','sh-cmd',        // 消息正文 / 代码 / shell 输出与命令
      't-name','t-arg','ag-p','ag-n',                // 工具名、工具入参、扩展路径与包名
      'mi-n','mi-tag','mdl-prov','mdl-name','mdl-arg',// 模型 id / 标签 / 服务商
      'fp','fname','fpath','filebar-p',              // 文件路径与文件名
      'sess-name','todo-txt','search-c','att-n','att-s', // 会话标题 / 待办正文 / 附件名
      'hl-en','tb-brand','sb-keys',                  // 品牌字、快捷键提示（含 ESC 等保留词）
      'pal-list'                                     // 命令/文件面板里的候选项
    ]);
    // 内容位（按**标签名**）：<pre>/<code> 装的是工具原始输出、参数 JSON、代码 —— 天生英文
    // （上一版把 'pre' 当成类名塞进 CONTENT_CLS，结果一个都没排掉）
    const CONTENT_TAG = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA']);
    // 虽然是"标签位"，但它们在 #log 里（#log 是内容位）—— 必须单独留下，否则 .who 会被一起排掉
    // 它们虽然是"标签位"，但祖先落在内容位里（#log / #session-list）——
    // 必须单独捞出来，否则会被一起排掉（.who 和 .md-copy 都踩过这个坑）
    const KEEP_CLS = new Set(['who', 'att-note', 'sh-code', 'md-copy', 'f-ico', 'm-btn', 'sess-op']);
    // 内容/数据位（按 id）
    const CONTENT_ID = new Set([
      'log','input','mirror','attbar','files-list','ext-list','pal-list','session-list',
      'kv-model','kv-model2','kv-cwd','kv-time','kv-round','ub-text','files-root',
      'set-cli','set-session','set-cwd','set-agentdir','set-mode','set-model'
    ]);
    const cls0 = (el) => String(el.className || '').trim().split(/\\s+/)[0];
    const inContent = (el) => {
      if (KEEP_CLS.has(cls0(el))) return false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        if (CONTENT_ID.has(p.id) || CONTENT_CLS.has(cls0(p)) || CONTENT_TAG.has(p.tagName)) return true;
      }
      return false;
    };
    const skipped = [];
    const out = [];
    const walk = (el) => {
      let hasEl = false;
      for (const n of el.childNodes) if (n.nodeType === 1) { hasEl = true; break; }
      if (hasEl) { for (const n of el.childNodes) if (n.nodeType === 1) walk(n); return; }
      const t = (el.textContent || '').trim();
      if (!t) return;
      const c0 = cls0(el);
      if (inContent(el)) { skipped.push(c0 || ('#' + el.id) || el.tagName.toLowerCase()); return; }
      out.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c0 ? '.' + c0 : ''), t: t });
    };
    walk(document.body);
    return { labels: out, skipped: skipped };
  })()`);
  const labelList = labels.labels || [];
  console.log('  ℹ 扫到 ' + labelList.length + ' 个标签位，排除 ' + (labels.skipped || []).length + ' 个内容位');
  console.log('  ℹ 排除的内容位: ' + JSON.stringify(Array.from(new Set(labels.skipped || []))));
  const EN_OK = ['JSON', 'ESC', 'pi', 'PixelAgent', 'PIXELAGENT', 'PIXEL()', 'v1.0',
    '...', '?', '—', '□', '✕', '↻', '▾', '▶', '▼', '⚙', '■', '·', '#—', 'OK'];
  // 纯 ASCII 的短纯符号/数字（'#1'、'0.0s'、'--:--:--'）不算英文标签
  const isEnglishLabel = (s) => /^[\x20-\x7E]+$/.test(s) && /[A-Za-z]/.test(s) && EN_OK.indexOf(s) < 0;
  const bad = labelList.filter((x) => isEnglishLabel(x.t));
  const badUniq = Array.from(new Set(bad.map((x) => x.sel + ' = ' + x.t)));
  console.log('  ℹ 纯英文标签: ' + JSON.stringify(badUniq));
  t('没有整块都是英文的界面标签', badUniq.length, 0);

  // 第二道：混在中文里的英文关键词（纯英文检查抓不到 "⏎ SEND · ESC STOP" 这种）
  const BLOCK = ['SESSIONS', 'COMMANDS', 'REFERENCE', 'STANDBY', 'THINKING', 'WORKING',
    'RENAME()', 'DELETE()', 'INPUT()', 'SETTINGS()', 'MODEL()', 'EXIT ', 'IMG×',
    'COPY', 'RETRY', 'RUNNING', 'FAILED', 'SESSION #', 'BACKEND', 'WORKDIR', 'SEND',
    'TOOLS', 'TODOS', 'FILES', 'AGENTS', 'NEW'];
  const hitLines = BLOCK.map((w) => labelList.filter((x) => x.t.indexOf(w) >= 0)
    .map((x) => w + ' @ ' + x.sel + ' = ' + x.t)).reduce((a, b) => a.concat(b), []);
  const hits = Array.from(new Set(hitLines));
  console.log('  ℹ 命中的英文关键词: ' + JSON.stringify(hits));
  t('标签文字里没有残留的英文关键词', hits.length, 0);

  // 正向确认：新标签确实上了界面（避免"什么都没渲染"也算通过）
  const stateZh = await js(`(function(){ const e = document.getElementById('sb-state'); return e ? e.textContent.trim() : 'NO_EL'; })()`);
  console.log('  ℹ 状态灯: ' + stateZh);
  t('状态灯显示中文', /^[\u4e00-\u9fa5]+$/.test(stateZh), true);
  const visZh = await js(`(function(){ const e = document.getElementById('kv-vis'); return e ? e.textContent.trim() : 'NO_EL'; })()`);
  console.log('  ℹ 看图标记: ' + visZh);
  t('看图标记不是 YES/NO', visZh !== 'YES' && visZh !== 'NO', true);
  // 内部值必须还是英文（CSS 动画 / setState 选择器都依赖它）
  const dataEnv = await js(`(function(){
    const t = document.getElementById('sb-state');
    const g = document.getElementById('pixel-girl');
    return { status: t && t.dataset.status, girl: g && g.dataset.state };
  })()`);
  console.log('  ℹ 内部状态值: ' + JSON.stringify(dataEnv));
  t('状态灯的 data-status 仍是英文内部值', ['IDLE','THINKING','TOOL','DONE'].indexOf(dataEnv.status) >= 0, true);
  t('女孩的 data-state 与状态灯同源', dataEnv.girl, dataEnv.status);

  /* ================= 8. 收尾截图 ================= */
  await js(`document.querySelector('.rtab[data-tab="tools"]').click()`);
  await sleep(300);
  await shot('11-final.png');

  // 保险：万一中间哪一步抛了，一次性会话别留在老板的列表里
  try { if (fs.existsSync(tmpSessFile)) fs.rmSync(tmpSessFile, { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpExportDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n================ 汇总 ================');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  app.exit(fail ? 1 : 0);
});

app.on('window-all-closed', () => app.exit(0));
