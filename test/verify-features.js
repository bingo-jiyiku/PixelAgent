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
  // ★ 前提写全了没有？第一版这里只清 `curModel` 就以为是"未知"了 ——
  //   但上一轮给 activeModelName 加了 `piDefault` 回退（没手动切过模型时用 pi 配置
  //   里的默认模型），于是"只清 curModel"其实**还是知道**的：它会落到
  //   agent-plan/ark-code-latest，而 pi 的模型表说这个模型 `images: no`
  //   ⇒ 走的是"明确不支持"那一支，中性提示当然断言不到。
  //   要造真正的"未知"，curModel 和 piDefault 都得清掉（同时用不到 models 目录）。
  const hintUnknown = await js(`(function(){
    const S = window.__pixel;
    S.__bakPiDefault = S.piDefault;   // 存起来，下面要用回来
    S.curModel = null;
    S.piDefault = null;
    document.getElementById('kv-model').textContent = '—';
    renderAtt();
    const w = document.querySelector('#attbar .att-warn');
    return { cls: w ? w.className : 'NONE', eff: S.curModel || S.piDefault || null };
  })()`);
  console.log('  ℹ 未知态: ' + JSON.stringify(hintUnknown));
  t('造出了真正"模型能力未知"的前提（effModel 为空）', hintUnknown.eff, null);
  t('能力未知时给出中性提示', hintUnknown.cls.indexOf('note') >= 0, true);

  const hintNo = await js(`(function(){
    const S = window.__pixel;
    S.piDefault = S.__bakPiDefault;   // 恢复 pi 默认，"未知"和"知道但不支持"必须区分开
    window.__pixel.curModel = { provider: 'p', model: '__不存在的不看图的模型__' };
    window.__pixel.models = [{ provider: 'p', model: '__不存在的不看图的模型__', images: false }];
    renderAtt();
    const w = document.querySelector('#attbar .att-warn');
    const strong = w && w.className.indexOf('note') < 0;
    return { cls: w ? w.className : 'NONE', strong: !!strong };
  })()`);
  t('明确不支持看图时给强警告', hintNo.strong, true);

  // 收尾：把模型状态清回去，免得影响后面几段
  await js(`(function(){ const S = window.__pixel;
    S.curModel = null;
    if (S.__bakPiDefault) S.piDefault = S.__bakPiDefault;
    delete S.__bakPiDefault;
    window.__pixel.models = [];
    document.getElementById('kv-model').textContent = '—'; renderAtt(); return true; })()`);
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
  //
  // ★ 用 sensenova / sensenova-6.8-flash-lite（老板指定）。三点好处：
  //   ① pi 表里 `images = yes`、`input: ["text","image"]`，确认能看图；
  //   ② 它是 flash-lite，跑一次端到端比原来那个 doubao-seed-2-1-pro（1.0M/256K）快得多；
  //   ③ 它的 contextWindow = 262144 是**模型自己声明的**（models.json 里写死了），
  //      跟默认模型 ark-code-latest「没声明 → 走 pi 的 128000 兜底」正好是一对对照 ——
  //      第 [10] 段的分母来源断言因此有了"声明值 / 兜底值"两种真样本。
  // ★ 判「能不能看图」一律看 pi 表的 `images` 列，**不靠模型名猜**（名字里没有
  //   vision/vl 的也可能是视觉模型，见知识库 2026-10-08 那条）。
  const visionModel = { provider: 'sensenova', model: 'sensenova-6.8-flash-lite' };
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
  // ★ 命令面板要**先打开**，它的候选项（.pal-k / .pal-d）才会进入 DOM。
  //   不打开的话，"按 class 排除候选项"这条规则恒等于没被执行过 ——
  //   又是一个"以为排了其实没排"的盲区。打开之后下面还要反过来确认
  //   分组标题（.pal-group）**在**体检范围内，证明排除是按 class 而不是按整个容器。
  await js(`(function(){ const i=document.getElementById('input'); i.value='/'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(450);
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
  const palItemN = await js(`document.querySelectorAll('#pal-list .pal-item').length`);
  console.log('  ℹ 体检时命令面板候选项数: ' + palItemN + '（>0 才说明 .pal-k/.pal-d 的排除规则被真正执行到）');
  t('体检时命令面板是打开的（否则排除规则是空转）', palItemN > 0, true);
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
      // 命令面板里的**候选项**（命令键 / 文件名 / 描述里带路径）是数据，按 class 排掉。
      // ⚠ 上一版排的是整个 'pal-list'（CONTENT_ID），那会把"最近使用""没有这个命令"
      //   这些**真标签**一起排掉 —— 等于给未来的英文残留开了个后门。所以改成按 class 排。
      'pal-k','pal-d'
    ]);
    // 内容位（按**标签名**）：<pre>/<code> 装的是工具原始输出、参数 JSON、代码 —— 天生英文
    // （上一版把 'pre' 当成类名塞进 CONTENT_CLS，结果一个都没排掉）
    // SELECT：设置面板里的下拉，option 装的是模型 id / 档位值，是**控件数据**不是界面标签；
    //        它左边永远配着一个中文的 .set-lb 标题，中文检查照样能覆盖到那一行。
    const CONTENT_TAG = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA', 'SELECT']);
    // 虽然是"标签位"，但它们在 #log 里（#log 是内容位）—— 必须单独留下，否则 .who 会被一起排掉
    // 它们虽然是"标签位"，但祖先落在内容位里（#log / #session-list）——
    // 必须单独捞出来，否则会被一起排掉（.who 和 .md-copy 都踩过这个坑）
    const KEEP_CLS = new Set(['who', 'att-note', 'sh-code', 'md-copy', 'f-ico', 'm-btn', 'sess-op']);
    // 内容/数据位（按 id）
    const CONTENT_ID = new Set([
      'log','input','mirror','attbar','files-list','ext-list','session-list',
      'kv-model','kv-model2','kv-cwd','kv-time','kv-round','ub-text','files-root',
      'set-cli','set-session','set-agentdir','set-mode','set-curmodel'
      // set-curmodel 装的是 "provider/model"（英文字面值），set-mode 是 "JSON（…）"，
      // 都是**读回来的运行数据**不是界面标签；set-note 是动态状态文案，**故意不排**，
      // 让它的中文也一起被体检到。
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
  // API Key：业界通用技术术语，中文写「API 密钥」反而怪（老板原意就是让用户填这个）
  const EN_OK = ['JSON', 'ESC', 'pi', 'PixelAgent', 'PIXELAGENT', 'PIXEL()', 'v1.0', 'API Key',
    '...', '?', '—', '□', '✕', '↻', '▾', '▶', '▼', '⚙', '■', '·', '#—', 'OK'];
  // 纯 ASCII 的短纯符号/数字（'#1'、'0.0s'、'--:--:--'）不算英文标签
  const isEnglishLabel = (s) => /^[\x20-\x7E]+$/.test(s) && /[A-Za-z]/.test(s) && EN_OK.indexOf(s) < 0;
  const bad = labelList.filter((x) => isEnglishLabel(x.t));
  const badUniq = Array.from(new Set(bad.map((x) => x.sel + ' = ' + x.t)));
  console.log('  ℹ 纯英文标签: ' + JSON.stringify(badUniq));
  t('没有整块都是英文的界面标签', badUniq.length, 0);

  // 反向确认排除范围没扩过头：命令面板的分组标题必须**还在**被检查的名单里。
  // 如果哪天有人图省事把 '#pal-list' 整个塞进排除表，这条会立刻红。
  const palGroups = labelList.filter((x) => x.sel.indexOf('pal-group') >= 0).length;
  console.log('  ℹ 命令面板分组标题进体检的数量: ' + palGroups);
  t('命令面板分组标题没有被打包排除掉（排除是按 class，不是按容器）', palGroups > 0, true);
  // 同理：设置面板那些中文行标题必须在名单里（它不是内容位）
  const setLabels = labelList.filter((x) => x.sel.indexOf('set-lb') >= 0).length;
  console.log('  ℹ 设置面板行标题进体检的数量: ' + setLabels);
  t('设置面板的行标题也在体检范围内', setLabels >= 6, true);
  // 体检完把面板收掉，别把浮层带进后面的截图和断言
  await js(`(function(){ const i=document.getElementById('input'); i.value=''; i.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(250);

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

  /* ================= 8. 设置 / 命令面板 / 命名 ================= */
  // 这一段盯的是老板这轮提的三件事：
  //   ①「设置要有设置该有的功能」→ 改得动 + 存得下 + 重启后还在（三条都要证据）
  //   ②「/命名要有该有的功能」  → 带参数直接改、重名拦下、留空回落自动标题
  //   ③ 顺带把命令面板该有的（模糊/高亮/分组/无结果/参数提示）逐条钉住
  console.log('\n[8] 设置 / 命令面板 / 命名');

  /* ---- 8a. 设置：三层对账（界面控件 → 配置文件 → 生效的样式） ---- */
  const cfgFile = path.join(__dirname, '..', '.pixelagent.json');
  const readFileCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return {}; } };
  const cfgBefore = readFileCfg();

  await js(`document.getElementById('btn-settings').click()`);
  await sleep(1100);          // 里面要真跑一次 pi:info + 拉模型目录

  const ctl = await js(`(function(){
    const q = (s)=>document.querySelector(s);
    const tn = (s)=> q(s) ? q(s).tagName : 'MISSING';
    const ty = (s)=> q(s) ? (q(s).type||'') : 'MISSING';
    return {
      cwd: tn('#set-cwd'), model: tn('#set-model'), think: tn('#set-thinking'),
      maxT: ty('#set-maximg'), mascotT: ty('#set-mascot'), compactT: ty('#set-compact'),
      scrollT: ty('#set-scroll'),
      accents: document.querySelectorAll('#set-accent .seg-b').length,
      enterSeg: document.querySelectorAll('#set-enter .seg-b').length,
      exportSeg: document.querySelectorAll('#set-export .seg-b').length,
      thinkOpts: document.querySelectorAll('#set-thinking option').length
    };
  })()`);
  console.log('  ℹ 设置面板控件: ' + JSON.stringify(ctl));
  t('工作目录是真输入框（不是只读一行）', ctl.cwd, 'INPUT');
  t('默认模型是真下拉', ctl.model, 'SELECT');
  t('思考档位是真下拉', ctl.think, 'SELECT');
  t('思考档位有 7 档 + 默认', ctl.thinkOpts, 8);
  t('图片上限是 number 框', ctl.maxT, 'number');
  t('吉祥物动画是 checkbox', ctl.mascotT, 'checkbox');
  t('紧凑模式是 checkbox', ctl.compactT, 'checkbox');
  t('自动滚到底是 checkbox', ctl.scrollT, 'checkbox');
  t('主题色有 4 个色块', ctl.accents, 4);
  t('Enter 行为有两个选项', ctl.enterSeg, 2);
  t('导出格式有三个选项', ctl.exportSeg, 3);

  /* ---- 8a-2. Esc 必须关掉设置面板，而不是掉进 doAbort（那会误中断正在跑的这轮） ----
     原来的 bug：文档级 keydown 只有 mask-input / mask-model 两支，
     设置面板开着时 Esc 会掉到 `if (activeElement !== input) doAbort()`。
     两个"差点测不到"的点，都要在这里把前提量出来：
       ① doAbort 有 `if (!S.busy) return`，没在跑就什么都不发生
          → 验收计数放在 busy 判断之前（window.__pixelAborts）；
       ② 中断分支要求焦点**不在**聊天输入框，而输入框启动时自动聚焦
          → 先把焦点移进面板，否则走不到那一支。 */
  // ★ 这条断言必须**自己报告**当时哪几个浮层是开着的。
  //   否则它红了只能说"没关上"，而"没关上"的一种原因是**被前面某一支接住了**
  //   （文档级 handler 的顺序是 mask-input → mask-model → mask-mcfg → mask → doAbort）。
  //   我第一版只读 #mask 一个，红了之后无从下手 —— 这跟"我没找到 / 它不存在
  //   必须是两句不同的话"是同一类毛病：把"哪一支接住了"这个关键信息丢掉了。
  const escPre = await js(`(function(){
    document.getElementById('set-cwd').focus();
    var probe = function(id){ var e=document.getElementById(id);
      if (!e) return 'NOT_FOUND';
      return getComputedStyle(e).display === 'none' ? 'hidden' : 'VISIBLE'; };
    var masks = {};
    // 按**文档级 handler 里的判断顺序**摆：谁是第一个 VISIBLE 的，谁就接住了这次 Esc
    ['mask-input','mask-model','mask-mcfg','mask'].forEach(function(id){ masks[id] = probe(id); });
    var firstHit = Object.keys(masks).filter(function(k){ return masks[k] === 'VISIBLE'; });
    return { notChatInput: document.activeElement !== document.getElementById('input'),
             aborts: window.__pixelAborts, masks: masks, visibleMasks: firstHit,
             winner: firstHit[0] || 'NONE' }; })()`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(350);
  const escPost = await js(`(function(){
    return { hidden: document.getElementById('mask').classList.contains('hidden'),
             aborts: window.__pixelAborts }; })()`);
  console.log('  ℹ Esc 前各浮层: ' + JSON.stringify(escPre.masks) +
    ' · 接住 Esc 的是: ' + escPre.winner);
  console.log('  ℹ Esc：焦点在面板内=' + escPre.notChatInput +
    ' → 关面板=' + escPost.hidden + ' 中断计数 ' + escPre.aborts + '→' + escPost.aborts);
  t('前提成立：焦点在面板内（否则下面两条是空转）', escPre.notChatInput, true);
  t('前提成立：此刻只有设置面板是开着的（别的浮层开着就会先接住 Esc）',
    escPre.visibleMasks.join(',') || 'NONE', 'mask');
  t('设置面板开着时 Esc 能关掉面板', escPost.hidden, true);
  t('Esc 关面板没有顺手中断正在跑的这轮', escPost.aborts, escPre.aborts);
  // 注意：本文件的 t() 是**严格相等**，不是 shot-settings.js 里的 JSON 比较 ——
  // 所以断言值一律取标量（这里用 'NONE' 当空数组的哨兵），别拿数组去比。
  t('关完之后没有浮层残留', await js(`(function(){
    var left = ['mask','mask-model','mask-input','mask-mcfg'].filter(function(id){
      var e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none'; });
    return left.length ? left.join(',') : 'NONE'; })()`), 'NONE');
  await js(`document.getElementById('btn-settings').click()`);   // 后面 8a 还要改设置
  await sleep(1200);

  // 故意选一个**跟当前盘上不一样**的值：否则"存进去了"这条断言是空转
  const META = await js(`window.pixelAPI.cfg()`);
  const ACC = (META && META.accents) || {};
  const targetAccent = (cfgBefore.accent === 'teal') ? 'amber' : 'teal';
  const targetMax = (Number(cfgBefore.maxImages) === 7) ? 6 : 7;
  console.log('  ℹ 盘上原本: accent=' + cfgBefore.accent + ' maxImages=' + cfgBefore.maxImages +
    ' → 本轮改成 ' + targetAccent + ' / ' + targetMax);

  await js(`(function(){
    const segs = document.querySelectorAll('#set-accent .seg-b');
    for (const b of segs) if (b.dataset.v === ${JSON.stringify(targetAccent)}) b.click();
    const m = document.getElementById('set-maximg'); m.value = ${JSON.stringify(String(targetMax))};
    const msc = document.getElementById('set-mascot'); msc.checked = false; msc.dispatchEvent(new Event('change'));
    return 1; })()`);
  await sleep(250);
  // 预览生效（还没保存）
  const previewLav = await js(`getComputedStyle(document.documentElement).getPropertyValue('--lav').trim()`);
  t('点主题色立刻预览（--lav 已变）', previewLav.toLowerCase(), String((ACC[targetAccent] || {}).main).toLowerCase());
  t('（反向）盘上此刻还是旧值', readFileCfg().accent === cfgBefore.accent, true);

  await js(`document.getElementById('set-save').click()`);
  await sleep(1400);
  const cfgAfter = readFileCfg();
  console.log('  ℹ 保存后盘上: ' + JSON.stringify({ accent: cfgAfter.accent, maxImages: cfgAfter.maxImages, mascotAnim: cfgAfter.mascotAnim }));
  t('保存后 accent 写进了 .pixelagent.json', cfgAfter.accent, targetAccent);
  t('保存后 maxImages 写进了 .pixelagent.json', cfgAfter.maxImages, targetMax);
  t('保存后 mascotAnim 写进了 .pixelagent.json', cfgAfter.mascotAnim, false);
  t('保存后盘上值确实变了（否则上面三条是空转）', cfgBefore.accent !== cfgAfter.accent, true);
  t('关掉动画 → body 上有 no-anim（这个开关是真起作用的）',
    await js(`document.body.classList.contains('no-anim')`), true);
  const noteTxt = await js(`document.getElementById('set-note').textContent`);
  console.log('  ℹ 保存回执: ' + JSON.stringify(noteTxt));
  t('保存后给了回执（不是默默存完）', noteTxt.length > 0, true);

  // 主进程**不认识**的键必须如实报出来（界面笔误时才能一眼看出）
  const dropRes = await js(`window.pixelAPI.setCfg({ mascot: true, maxImages: 3 })`);
  console.log('  ℹ 故意传一个错键: ' + JSON.stringify({ dropped: dropRes && dropRes.droppedKeys }));
  t('不认识的键被报出来而不是默默吞掉',
    !!(dropRes && dropRes.droppedKeys && dropRes.droppedKeys.indexOf('mascot') >= 0), true);
  t('认识的键照常生效', dropRes && dropRes.cfg && dropRes.cfg.maxImages, 3);

  // 越界值要被夹回默认（校验不是在界面上做的）
  const clampRes = await js(`window.pixelAPI.setCfg({ maxImages: 999, accent: '彩虹', exportFormat: 'exe' })`);
  t('越界的 maxImages 被夹回默认 4', clampRes && clampRes.cfg && clampRes.cfg.maxImages, 4);
  t('不存在的主题色被夹回默认', clampRes && clampRes.cfg && clampRes.cfg.accent, 'lav');
  t('不存在的导出格式被夹回默认', clampRes && clampRes.cfg && clampRes.cfg.exportFormat, 'html');

  // 关掉面板（取消会把预览回滚，这里已经保存过，直接关）
  await js(`(function(){ const b=document.getElementById('set-cancel'); if(b) b.click(); return 1; })()`);
  await sleep(300);

  // 恢复默认 → 盘上必须回到默认值（否则测试会污染老板的配置）
  const reset = await js(`window.pixelAPI.resetCfg()`);
  t('恢复默认返回成功', !!(reset && reset.ok), true);
  t('恢复默认后盘上是默认值', readFileCfg().accent, 'lav');
  t('恢复默认后盘上是默认值 maxImages', readFileCfg().maxImages, 4);
  // 把测试开始前的配置还回去（万一老板本来改过设置，不能被这个测试洗掉）
  const restore = Object.assign({}, cfgBefore);
  delete restore.workDir;                  // 工作目录不归这一段管，也不该被重设
  await js(`window.pixelAPI.setCfg(${JSON.stringify(restore)})`);
  t('测试跑完把老板原来的设置还回去了', readFileCfg().accent, cfgBefore.accent);

  /* ---- 8b. Enter 键行为：设置说"换行"时，Enter 就不能发送 ---- */
  await js(`window.__pixelApplyCfg(Object.assign({}, window.__pixelCfg(), { enterToSend: false }))`);
  const logN0 = await js(`document.querySelectorAll('#log .m').length`);
  await js(`(function(){ const i=document.getElementById('input'); i.value='!echo pxl-enter-probe';
    i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1; })()`);
  await sleep(500);
  const logN1 = await js(`document.querySelectorAll('#log .m').length`);
  t('enterToSend=false 时 Enter 不发送（换行）', logN1, logN0);
  // 反向：Ctrl+Enter 必须能发（走 `!` 命令，不烧 token 也不经过模型）
  await js(`(function(){ const i=document.getElementById('input');
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); return 1; })()`);
  await sleep(900);
  const logN2 = await js(`document.querySelectorAll('#log .m').length`);
  t('enterToSend=false 时 Ctrl+Enter 能发送（否则这个设置等于把发送废掉了）', logN2 > logN1, true);
  await js(`window.__pixelApplyCfg(Object.assign({}, window.__pixelCfg(), { enterToSend: true }))`);
  await js(`(function(){ const i=document.getElementById('input'); i.value=''; i.dispatchEvent(new Event('input')); return 1; })()`);

  /* ---- 8c. 命令面板：模糊 / 高亮 / 分组 / 无结果 / 参数提示 ---- */
  const typeIn = async (v) => {
    await js(`(function(){ const i=document.getElementById('input');
      i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return 1; })()`);
    await sleep(260);
  };
  const palState = () => js(`(function(){
    const on = document.querySelector('#pal-list .pal-item.on');
    return {
      open: !document.getElementById('palette').classList.contains('hidden'),
      items: document.querySelectorAll('#pal-list .pal-item').length,
      groups: Array.prototype.map.call(document.querySelectorAll('#pal-list .pal-group'), function(e){return e.textContent.trim();}),
      first: on ? on.querySelector('.pal-k').textContent.trim() : 'NONE',
      hits: document.querySelectorAll('#pal-list .pal-hit').length,
      empty: (document.querySelector('#pal-list .pal-empty') || { textContent: '' }).textContent,
      foot: document.getElementById('pal-foot').textContent
    };
  })()`);

  await typeIn('/');
  const ps1 = await palState();
  console.log('  ℹ 输入 / → ' + JSON.stringify({ open: ps1.open, items: ps1.items, groups: ps1.groups }));
  t('输入 / 打开命令面板', ps1.open, true);
  // 老板 2026-10-11：命令表减到 7 条（删掉了 /tools /todos /files /agents
  // /search /settings /info 七条"点按钮就能做"的），所以下限也跟着降到 7。
  // 断言还是保留，防的是"命令被误删空"这类事故。
  t('候选项够多（不是只剩一条）', ps1.items >= 7, true);
  t('候选项有分组标题', ps1.groups.length >= 3, true);
  t('分组标题是中文', ps1.groups.every((g) => /^[\u4e00-\u9fa5]+$/.test(g)), true);

  await typeIn('/rn');
  const ps2 = await palState();
  console.log('  ℹ 输入 /rn → ' + JSON.stringify({ first: ps2.first, items: ps2.items, hits: ps2.hits }));
  t('/rn 首选就是 /rename（模糊匹配真的按顺序匹配）', ps2.first, '/rename');
  t('命中字符被高亮出来（有 .pal-hit）', ps2.hits > 0, true);
  t('/rn 把候选收敛下来', ps2.items < 6, true);

  await typeIn('/rename');
  const ps3 = await palState();
  console.log('  ℹ 高亮 /rename 时底部提示: ' + JSON.stringify(ps3.foot));
  t('/rename 底部给出参数写法', ps3.foot.indexOf('/rename') >= 0, true);

  await typeIn('/zzz');
  const ps4 = await palState();
  console.log('  ℹ 输入 /zzz → ' + JSON.stringify({ open: ps4.open, empty: ps4.empty }));
  t('没有匹配时**不关**面板', ps4.open, true);
  t('没有匹配时给出中文提示', /[\u4e00-\u9fa5]/.test(ps4.empty), true);

  /* ---- 8d. 命名：带参数直接改名 / 重名拦下 / 留空回落 ---- */
  const TMP2 = 996;
  const tmp2File = path.join(__dirname, '..', '.sessions', 'chat-' + TMP2 + '.json');
  const nowIso2 = new Date().toISOString();
  fs.writeFileSync(tmp2File, [
    { type: 'session', version: 3, id: 'verify-996', timestamp: nowIso2, cwd: path.join(__dirname, '..') },
    { type: 'message', id: 'u996', parentId: null, timestamp: nowIso2,
      message: { role: 'user', content: [{ type: 'text', text: '命名验收用的一次性会话' }], timestamp: Date.now() } }
  ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  const NAME = '验收临时名';
  // `/rename` 改的是**当前会话**，所以先把当前会话切到这条一次性会话上
  // （走渲染层的 openSession，S.seq 才会跟着变；裸调 IPC 会导致测歪）
  const origSeq = (await js(`window.pixelAPI.sessions()`)).current;
  await js(`window.__pixelOpenSession(${TMP2})`);
  await sleep(900);
  t('已切到一次性会话', await js(`window.pixelAPI.sessions().then(function(r){return r.current;})`), TMP2);

  await typeIn('/rename ' + NAME);
  const ps5 = await palState();
  console.log('  ℹ 输入 /rename 名字 → ' + JSON.stringify({ items: ps5.items, first: ps5.first }));
  t('带参数时只剩一条候选', ps5.items, 1);
  t('候选标签是完整写法', ps5.first, '/rename ' + NAME);
  // 回车执行（直接打在输入框上）
  await js(`(function(){ document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1; })()`);
  await sleep(900);

  const sessAfterRename = await js(`window.pixelAPI.sessions()`);
  const row996 = ((sessAfterRename.sessions || []).filter((s) => s.seq === TMP2))[0] || {};
  t('/rename 名字 真的改了名', row996.title, NAME);
  t('改名带上了「已改名」标记', row996.renamed, true);
  t('改名落盘了', (readFileCfg().names || {})[String(TMP2)], NAME);
  const railHas = await js(`document.getElementById('session-list').textContent.indexOf(${JSON.stringify(NAME)}) >= 0`);
  t('左栏立刻反映新名字', railHas, true);

  // 重名校验：改成另一条会话已经在用的标题 → 必须拦下并指名道姓
  const otherName = ((sessAfterRename.sessions || []).filter((s) => s.seq !== TMP2 && s.title))[0] || {};
  const clash = await js(`window.pixelAPI.renameSession(${TMP2}, ${JSON.stringify(otherName.title || '')} )`);
  console.log('  ℹ 重名结果: ' + JSON.stringify({ reason: clash && clash.reason, clash: clash && clash.clash }));
  t('重名被拦下', clash && clash.reason, 'NAME_TAKEN');
  t('拦下时告诉撞的是哪一条', typeof (clash && clash.clash), 'number');
  t('被拦下时原名没有被改掉', (((await js(`window.pixelAPI.sessions()`)).sessions || [])
    .filter((s) => s.seq === TMP2)[0] || {}).title, NAME);

  // 留空 = 恢复自动标题（界面上的「重命名」对话框走的是同一条路）
  const cleared = await js(`window.pixelAPI.renameSession(${TMP2}, '   ')`);
  t('留空可提交（不算非法）', !!(cleared && cleared.ok), true);
  t('留空后回落到自动标题',
    (((await js(`window.pixelAPI.sessions()`)).sessions || []).filter((s) => s.seq === TMP2)[0] || {}).title,
    '命名验收用的一次性会话');
  t('留空后别名从配置里删掉了', (readFileCfg().names || {})[String(TMP2)], undefined);

  // 界面上的重命名对话框也要能走通（改名 + 取消两条路）
  await js(`(function(){ const rows=document.querySelectorAll('#session-list .sess');
    for (const r of rows) { if (r.querySelector('.sess-idx') && r.querySelector('.sess-idx').textContent.trim()==='#996') {
      const b=r.querySelector('.sess-op'); if (b) b.click(); } }
    return 1; })()`);
  await sleep(500);
  const dlgOpen = await js(`!document.getElementById('mask-input').classList.contains('hidden')`);
  t('会话条上的「改名」能弹出对话框', dlgOpen, true);
  await js(`(function(){ const f=document.getElementById('inp-field'); f.value='对话框改的名';
    document.getElementById('inp-ok').click(); return 1; })()`);
  await sleep(800);
  t('对话框改名也能生效',
    (((await js(`window.pixelAPI.sessions()`)).sessions || []).filter((s) => s.seq === TMP2)[0] || {}).title,
    '对话框改的名');

  // 清理：一次性会话 + 它的别名，一个都不留
  await js(`window.pixelAPI.renameSession(${TMP2}, '')`);
  try { fs.rmSync(tmp2File, { force: true }); } catch (e) { /* ignore */ }
  t('清理后会话文件已移除', fs.existsSync(tmp2File), false);
  t('清理后别名也没留下', (readFileCfg().names || {})[String(TMP2)], undefined);
  // 把当前会话切回原来那条（测试把会话的"当前"改过，得还回去）
  if (typeof origSeq === 'number') { await js(`window.__pixelOpenSession(${origSeq})`); await sleep(700); }
  t('当前会话已切回原来那条',
    await js(`window.pixelAPI.sessions().then(function(r){return r.current;})`), origSeq);
  await typeIn('');

  /* ================= 9. 吉祥物：去框 / 互动 / 气泡文字 =================
     老板 2026-10-11：「形象不要有框框把吉祥物框住」、「希望吉祥物可以互动」，
     「我希望吉祥物是可以说话的」（已确认走"头顶冒文字气泡"，不是 TTS）。
     三条反向验证：
       ① 故意把 .office 的 border 加回来，断言必须红
       ② 故意把 click 事件的 girlSay 删掉，断言必须红
       ③ 故意把 girlSay 里的 setClassList.add('on') 删掉，断言必须红 */

  // ★ 老板 2026-10-11：吉祥物从 welcome 搬到左栏常驻后，测试不再依赖"welcome 在"。
  //   这里点 btn-new 只是为了让 setState('IDLE') 走一遍 → 自动冒 IDLE 气泡（3s 后消失）。
  //   btn-new 会调 newSession → doNewSessionLocal（IPC 异步），所以等够时间让整条链跑完。
  await js(`document.getElementById('btn-new').click()`);
  await sleep(1500);
  const girlInit = await js(`(function(){
    var office = document.getElementById('pixel-girl');
    var scene = document.getElementById('girl-scene');
    var bubble = document.getElementById('of-bubble-txt');
    if (!office || !scene || !bubble) return { ok:false };
    var st = getComputedStyle(office);
    return {
      ok: true,
      border: st.borderTopWidth + '/' + st.borderTopStyle,
      cursor: st.cursor,
      bubbleExists: !!bubble,
      initialOn: bubble.classList.contains('on')
    };
  })()`);
  console.log('  ℹ 吉祥物初始状态: ' + JSON.stringify(girlInit));
  t('office 没有边框（border-top-width 应该是 0px）', girlInit.ok && girlInit.border.indexOf('0px') >= 0, true);
  t('office 是可点的（cursor 应该不是 default）', girlInit.ok && girlInit.cursor !== 'default' && girlInit.cursor !== 'auto', true);
  t('气泡元素存在', girlInit.ok && girlInit.bubbleExists, true);

  // 等 IDLE 自动气泡消失（girlSay 3s 后移除 .on）
  await sleep(3200);
  const girlAfterIdle = await js(`document.getElementById('of-bubble-txt').classList.contains('on')`);
  console.log('  ℹ IDLE 气泡自动消失后 .on 类: ' + girlAfterIdle);
  t('IDLE 气泡 3s 后自动消失（.on 类被移掉）', !girlAfterIdle, true);

  // 触发一次点击 → 冒气泡
  await js(`(function(){
    var scene = document.getElementById('girl-scene');
    scene.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 1;
  })()`);
  await sleep(250);
  const girlAfterClick = await js(`(function(){
    var bubble = document.getElementById('of-bubble-txt');
    var office = document.getElementById('pixel-girl');
    return {
      text: bubble.textContent,
      on: bubble.classList.contains('on'),
      nod: office.classList.contains('girl-nod')
    };
  })()`);
  console.log('  ℹ 点击后: ' + JSON.stringify(girlAfterClick));
  t('点击后气泡里真的有字（不是空的）', girlAfterClick.text && girlAfterClick.text.length > 0, true);
  t('点击后气泡显示出来了（.on 类）', girlAfterClick.on, true);
  t('点击触发了点头动画（.girl-nod 类）', girlAfterClick.nod, true);

  // 气泡 2s 后自动消失
  await sleep(2400);
  const girlAfterWait = await js(`(function(){
    var bubble = document.getElementById('of-bubble-txt');
    return { text: bubble.textContent, on: bubble.classList.contains('on') };
  })()`);
  t('点击气泡 2s 后自动淡出（.on 类被移掉）', !girlAfterWait.on, true);

  /* ================= 9b. 新增自定义模型 =================
     老板 2026-10-11：模型菜单要有"新增自定义模型"入口。
     测的是 IPC 链路（写 models.json → pi --list-models 能看到 → 重复添加被拒）。
     跑完必须**清理** —— 把刚加的模型从 models.json 里删掉，否则下次启动
     pi 会看到一条测试残留。 */

  const TEST_PROVIDER = 'verify-test-provider';
  const TEST_MODEL = 'verify-test-model-xyz';
  // 先把现有 models.json 备份（读回来，测试完了按原样写回）
  const MJSON = path.join(__dirname, '..', '.pi-agent', 'models.json');
  const mjsonBackup = fs.readFileSync(MJSON, 'utf8');

  // 打开对话框
  await js(`(function(){
    document.getElementById('btn-model').click();
    return 1;
  })()`);
  await sleep(500);
  // 打开"新增模型"
  await js(`(function(){
    document.getElementById('mdl-add').click();
    return 1;
  })()`);
  await sleep(300);
  const maddOpen = await js(`(function(){
    var m = document.getElementById('mask-model-add');
    var dl = document.getElementById('madd-prov-list');
    return {
      open: !m.classList.contains('hidden'),
      fields: ['madd-provider','madd-model','madd-base','madd-key','madd-ctx','madd-max']
        .every(function(id){ return !!document.getElementById(id); }),
      provOptions: dl ? dl.options.length : 0
    };
  })()`);
  console.log('  ℹ 新增模型对话框: ' + JSON.stringify(maddOpen));
  t('新增模型对话框打开了', maddOpen.open, true);
  t('所有输入框都在（服务商/ID/base/key/ctx/max）', maddOpen.fields, true);
  t('服务商 datalist 已经填了已有服务商', maddOpen.provOptions >= 1, true);

  // 走 IPC 直接添加（避免依赖 UI 表单校验流程）
  const addR1 = await js(`window.pixelAPI.addModel({
    provider: ${JSON.stringify(TEST_PROVIDER)},
    modelId: ${JSON.stringify(TEST_MODEL)},
    baseUrl: 'https://verify-test.example/v1',
    apiKey: 'sk-test-1234',
    contextWindow: 128000,
    maxTokens: 4096
  })`);
  console.log('  ℹ 新增模型（第 1 次）: ' + JSON.stringify(addR1));
  t('新增模型 IPC 成功', addR1 && addR1.ok === true, true);

  // 直接读文件确认写进去了
  const doc = JSON.parse(fs.readFileSync(MJSON, 'utf8'));
  const prov = doc.providers && doc.providers[TEST_PROVIDER];
  t('models.json 里真的有这个 provider', !!prov, true);
  const addedModel = prov && prov.models && prov.models.find((m) => m.id === TEST_MODEL);
  t('models.json 里真的有这个模型', !!addedModel, true);
  t('写入的 contextWindow 是对的', addedModel && addedModel.contextWindow, 128000);
  t('写入的 maxTokens 是对的', addedModel && addedModel.maxTokens, 4096);

  // 反向验证：重复添加同名模型应该被拒
  const addR2 = await js(`window.pixelAPI.addModel({
    provider: ${JSON.stringify(TEST_PROVIDER)},
    modelId: ${JSON.stringify(TEST_MODEL)},
    baseUrl: '',
    apiKey: ''
  })`);
  console.log('  ℹ 重复添加: ' + JSON.stringify(addR2));
  t('重复添加同名模型被拒（避免静默覆盖）', addR2 && addR2.ok === false, true);
  t('拒绝原因提到了"已经存在"', addR2 && /已经存在|已存在/.test(addR2.error || ''), true);

  // 反向验证：provider 空 → 拒
  const addR3 = await js(`window.pixelAPI.addModel({ modelId: 'x' })`);
  t('provider 为空被拒', addR3 && addR3.ok === false, true);

  // 反向验证：modelId 空 → 拒
  const addR4 = await js(`window.pixelAPI.addModel({ provider: 'p', modelId: '' })`);
  t('modelId 为空被拒', addR4 && addR4.ok === false, true);

  // 反向验证：非正整数上下文窗口 → 拒
  const addR5 = await js(`window.pixelAPI.addModel({ provider: 'p', modelId: 'x', contextWindow: -1 })`);
  t('负数上下文窗口被拒', addR5 && addR5.ok === false, true);

  // 关闭对话框
  await js(`document.getElementById('madd-cancel').click()`);
  await sleep(100);
  t('对话框能关', await js(`document.getElementById('mask-model-add').classList.contains('hidden')`), true);

  // 清理：按原样写回 models.json
  fs.writeFileSync(MJSON, mjsonBackup, 'utf8');
  // ★ addModel 写完文件后清了 modelsCache，所以这里必须**主动重建一次**，
  //   否则后面 [10] 段跑 api.modelInfo 时 hit 是 null（modelsCache 是 null），
  //   mcfg-reported 就显示"pi 的表里没有这个模型" —— 断言会红。
  //   注意：这次 api.models() 会走 runPiQuery 重新跑 --list-models，拿到干净表
  //   （还原后的 models.json 里没有 verify-test-model 了）。
  const rebuild = await js(`window.pixelAPI.models()`);
  await sleep(500);
  // 顺便把 renderer 缓存同步一下（避免 S.models 和主进程 cache 不一致）
  if (rebuild && rebuild.ok && rebuild.models) {
    await js(`(function(){ S.models = ${JSON.stringify(rebuild.models)}; S.modelsLoaded = true; return 1; })()`);
  }
  console.log('  ℹ 测试清理：models.json 已还原，主进程 + renderer 缓存已重建');

  /* ================= 10. 本轮四件事 =================
     老板这轮的原话：
       「上下文怎么只有10万？上下文显示的是模型自己决定的还是你弄成十万的，
        还有当删除完所有会话时，没有主动返回主页，
        /命令不需要有模型命令，UI界面上已经有了，
        点开模型要有配置测试等功能，模型菜单要有折叠展开」
     对应四段：10a 分母从哪来 / 10b 删空回主页 / 10c 命令表去掉 /model /
              10d 模型行的「配置·测试」+ 分组折叠。
     每条都要能**反向验证**：把实现劣化回去，断言必须变红。 */
  console.log('\n[10] 上下文来源 / 删空回主页 / 去 /model / 模型配置与折叠');

  /* ---- 10a. 「这个分母是谁定的」—— 用真数据把来源链钉住 ----
     结论（三条独立证据，都在本机可取）：
       ① 界面显示的上下文 = pi `--list-models` 第 3 列（dist/cli/list-models.js 里
          `context: formatTokenCount(m.contextWindow)`）；
       ② `agent-plan/ark-code-latest` 在 `.pi-agent/models.json` 里**只有** `{"id":...}`，
          没声明 contextWindow；
       ③ pi 在 dist/core/provider-composer.js:109 写死 `contextWindow ?? 128000` ——
          所以它报 128K（128000，formatTokenCount 用 ÷1000）。
     ⇒ "10 万"不是我们写死的，是 pi 对"模型自己没声明"的兜底值 128000。
       代码里也没有任何 100000 硬编码（`grep 100000` 只剩配置上限 100000000）。 */
  await js(`window.pixelAPI.setModel(null)`);
  await js(`(function(){ window.__pixel.curModel = null; paintModelBar(); paintCtxIdle(); return 1; })()`);
  await sleep(400);

  const effNow = await js(`(function(){ const p=window.__pixel; return p.curModel || p.piDefault || null; })()`);
  console.log('  ℹ 生效模型（curModel 为 null 时跟随 pi 默认）: ' + JSON.stringify(effNow));
  t('没手动切过模型时，分母取的是 pi 配置里的默认模型', !!(effNow && effNow.model), true);

  const srcRow = await js(`(function(){
    const p = window.__pixel, em = p.piDefault || {};
    const hit = p.models.filter(function(m){ return m.model === em.model && (!em.provider || m.provider === em.provider); })[0];
    return hit ? { context: hit.context, maxOut: hit.maxOut, provider: hit.provider, model: hit.model } : null;
  })()`);
  console.log('  ℹ pi 模型表里那一行: ' + JSON.stringify(srcRow));
  t('pi 的模型表里确实有这个默认模型', !!srcRow, true);
  t('分母就是 pi 表里的第 3 列（不是我们另算的）', srcRow && srcRow.context, '128K');

  const ub1 = await js(`document.getElementById('ub-text').textContent`);
  console.log('  ℹ 用量条: ' + JSON.stringify(ub1));
  t('用量条的分母跟着 pi 表走（128K）', String(ub1).split('/').pop().trim(), '128K');
  t('用量条上说明了分母来源（hover 可见）',
    await js(`document.getElementById('sb-usage').title.indexOf('分母来源') >= 0`), true);
  // 点一下能看明细 —— 老板问"是模型自己决定的还是你弄的"，这里就该有答案
  await js(`document.getElementById('sb-usage').click()`);
  await sleep(400);
  const detailTxt = await js(`(function(){ const m=document.getElementById('mask-input'); return m ? m.textContent : ''; })()`);
  console.log('  ℹ 用量明细弹框（截断）: ' + JSON.stringify(String(detailTxt).slice(0, 160)));
  t('点用量条能打开明细弹框', await js(`!document.getElementById('mask-input').classList.contains('hidden')`), true);
  t('明细里写清了「分母来源」', String(detailTxt).indexOf('分母来源') >= 0, true);
  // 这条要**指名道姓**地断言，不能只断言"提到了 pi 表" ——
  // 那句话在"表里没有这个模型"时也会出现，恒真的断言等于没写。
  t('明细里点名 pi 表写的就是 128K', String(detailTxt).indexOf('pi 表里写的是 128K') >= 0, true);
  await js(`(function(){ const b=document.getElementById('inp-cancel'); if(b) b.click(); return 1; })()`);
  await sleep(300);

  /* ---- 10a-2. 分母可以被用户改，且改了立刻生效（自我清理） ---- */
  await js(`document.getElementById('btn-model').click()`);
  await sleep(1500);                    // 里面会真跑 pi --list-models
  t('模型框打开了', await js(`!document.getElementById('mask-model').classList.contains('hidden')`), true);
  // `#mdl-q` 可能被上一段留下过滤词 —— 清空，否则行不存在，"配置"按钮当然也找不到
  await js(`(function(){ const q=document.getElementById('mdl-q'); q.value=''; q.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(400);
  // 折叠状态是**持久化**的（localStorage），上一次跑留下的状态会让断言飘 —— 先清干净
  await js(`(function(){ try{ localStorage.removeItem('pixelagent.collapsedProvs'); }catch(e){}
    window.__pixel.collapsedProvs = new Set();
    const q=document.getElementById('mdl-q'); q.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(400);

  const clickRowOp = (model, op) => js(`(function(){
    const rows = [].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
    const row = rows.filter(function(r){ const n=r.querySelector('.mi-n'); return n && n.textContent.trim() === ${JSON.stringify(model)}; })[0];
    if (!row) return 'NO_ROW';
    const ops = [].slice.call(row.querySelectorAll('.mi-op'));
    const b = ops.filter(function(x){ return x.textContent.trim() === ${JSON.stringify(op)}; })[0];
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  })()`);

  const effModelName = (effNow && effNow.model) || '';
  const ovKey = ((effNow && effNow.provider) || '') + '/' + effModelName;
  const clickRes = await clickRowOp(effModelName, '配置');
  await sleep(900);
  console.log('  ℹ 点「配置」: ' + clickRes + ' → 弹框 open=' +
    await js(`!document.getElementById('mask-mcfg').classList.contains('hidden')`));
  t('模型行点「配置」能找到并打开弹框', clickRes, 'OK');
  t('配置弹框真的打开了', await js(`!document.getElementById('mask-mcfg').classList.contains('hidden')`), true);
  t('弹框标题带模型名', await js(`document.getElementById('mcfg-title').textContent.indexOf(${JSON.stringify(effModelName)}) >= 0`), true);
  t('只读区填了服务商', await js(`document.getElementById('mcfg-prov').textContent`), (effNow && effNow.provider) || '');
  // ★ 核心一条：把"模型自己声明的"和"pi 补的"分开说 —— 这就是老板那个问题的答案
  const repTxt = await js(`document.getElementById('mcfg-reported').textContent`);
  console.log('  ℹ mcfg-reported: ' + JSON.stringify(repTxt));
  t('配置框里指明了 pi 报的值', String(repTxt).indexOf('128K') >= 0, true);
  t('配置框里明说这是「模型没声明 → pi 的兜底值」', String(repTxt).indexOf('兜底') >= 0, true);
  t('上下文输入框的 placeholder 就是 pi 报的值',
    await js(`document.getElementById('mcfg-ctx').placeholder`), '128K');
  t('只读区告诉用户 pi 里有没有 key（但不回显内容）',
    /(有|没在)/.test(await js(`document.getElementById('mcfg-auth').textContent`)), true);

  // 改成 300K（300000 词元）→ 落盘 + 分母立刻跟着变
  // ★ 这一条上一轮是**红的**，而且是真 bug：
  //   主进程把 `modelOverrides` 这张表当"配置补丁"收，白名单一个顶层键都匹配不上
  //   ⇒ 值全丢、`modelOverrides` 一直是 `{}`，而界面只显示一句不痛不痒的提示。
  //   排错靠的是 test/probe-mcfg.js：把「值进没进输入框 / MCFG.sel 还在不在 /
  //   主进程说什么 / 磁盘上有没有」四个量同时打出来，而不是猜。
  await js(`(function(){ const i=document.getElementById('mcfg-ctx'); i.value='300000'; return 1; })()`);
  await js(`document.getElementById('mcfg-save').click()`);
  await sleep(1200);
  const saveNote = await js(`document.getElementById('mcfg-note').textContent`);
  console.log('  ℹ 保存后的提示语: ' + JSON.stringify(saveNote));
  t('保存没报「主进程不认识的键」（这条哨兵抓到过一次真 bug）',
    String(saveNote).indexOf('不认识'), -1);
  const ovSaved = ((readFileCfg().modelOverrides) || {})[ovKey] || null;
  console.log('  ℹ 落盘的覆盖值 ' + ovKey + ' = ' + JSON.stringify(ovSaved));
  t('覆盖值写进了配置文件', ovSaved && ovSaved.contextTokens, 300000);
  const ovUi = await js(`((window.__pixelCfg() || {}).modelOverrides || {})[${JSON.stringify(ovKey)}] || null`);
  t('渲染层也拿到了新配置（回执真的被应用了）', ovUi && ovUi.contextTokens, 300000);
  const ub2 = await js(`document.getElementById('ub-text').textContent`);
  console.log('  ℹ 改完分母后的用量条: ' + JSON.stringify(ub2));
  t('用量条的分母立刻按覆盖值重算（300K）', String(ub2).split('/').pop().trim(), '300K');
  t('列表里这一行也标了 *（表示被覆盖过）',
    await js(`(function(){ const rows=[].slice.call(document.querySelectorAll('#mdl-list .mdl-item'));
      const r=rows.filter(function(x){ const n=x.querySelector('.mi-n'); return n && n.textContent.trim()===${JSON.stringify(effModelName)}; })[0];
      return r ? r.querySelector('.mi-tag').textContent.indexOf('*') >= 0 : false; })()`), true);
  await js(`document.getElementById('sb-usage').click()`);
  await sleep(400);
  const det2 = await js(`document.getElementById('mask-input').textContent`);
  console.log('  ℹ 覆盖后的明细（截断）: ' + JSON.stringify(String(det2).slice(0, 150)));
  // 断言用**整句**，不用"含有'覆盖值'"这种松判据 —— 松判据在句子改一半时照样绿
  t('用量明细里认得出这是「你填的覆盖值」（来源会跟着变）',
    String(det2).indexOf('来自你在「模型配置」里填的覆盖值') >= 0, true);
  await js(`(function(){ const b=document.getElementById('inp-cancel'); if(b) b.click(); return 1; })()`);
  await sleep(300);

  // 反向验证 + 自我清理：清空 → 覆盖值必须从配置里消失、分母回到 pi 的值
  await sleep(500);   // 保存成功后弹框会自己关（700ms），等它关完再重开
  await clickRowOp(effModelName, '配置');
  await sleep(900);
  await js(`(function(){ const i=document.getElementById('mcfg-ctx'); i.value=''; return 1; })()`);
  await js(`document.getElementById('mcfg-save').click()`);
  await sleep(1200);
  t('清空后覆盖值从配置里删掉了',
    (((readFileCfg().modelOverrides) || {})[ovKey] || null), null);
  const ub3 = await js(`document.getElementById('ub-text').textContent`);
  console.log('  ℹ 清空后的用量条: ' + JSON.stringify(ub3));
  t('清空后分母回到 pi 的值（反向验证：覆盖真的生效过）', String(ub3).split('/').pop().trim(), '128K');

  /* ---- 10b. `/命令` 里不该再有「模型」这条 ---- */
  await js(`document.getElementById('mask-model').classList.add('hidden')`);
  await typeIn('/');
  const c10 = await palState();
  const allKs = await js(`Array.prototype.map.call(document.querySelectorAll('#pal-list .pal-k'), function(e){ return e.textContent.trim(); })`);
  console.log('  ℹ / 面板里的命令: ' + JSON.stringify(allKs));
  t('命令面板里没有 /model', allKs.indexOf('/model'), -1);
  t('命令面板里也没有叫「模型」的分组', c10.groups.indexOf('模型'), -1);
  await typeIn('/mod');
  const c10b = await palState();
  console.log('  ℹ 输入 /mod → ' + JSON.stringify({ open: c10b.open, items: c10b.items, empty: c10b.empty }));
  t('敲 /mod 一条都搜不到（是真删了，不是换了个名字）', c10b.items, 0);
  t('搜不到时给的是中文提示', /[\u4e00-\u9fa5]/.test(c10b.empty), true);
  // ★ "推荐语不许指向不存在的命令" —— 这条抓到过一次真漏：
  //   面板空态原来写的是"试试 /new、/model、/rename、/settings"，
  //   而 /model 早就删了。提示把用户指到一个不存在的命令上，比不提示更糟。
  //   判据不是"字符串里没有 /model"（那只是这一条），而是**推荐里每个命令都真的敲得到**。
  const hinted = String(c10b.empty).match(/\/[a-z]+/g) || [];
  console.log('  ℹ 空态提示推荐的命令: ' + JSON.stringify(hinted));
  t('空态提示里不再推荐 /model', hinted.indexOf('/model'), -1);
  t('空态提示里确实给了可推荐的命令', hinted.length > 0, true);
  for (const hk of hinted) {
    await typeIn(hk);
    const stH = await palState();
    t('推荐语里的 ' + hk + ' 真的存在（敲它第一条就是它）', stH.first, hk);
  }
  await typeIn('/mod');
  t('绕一圈回来 /mod 仍然搜不到', (await palState()).items, 0);
  // 反向验证：不是把整张命令表删空了
  await typeIn('/ren');
  t('反向验证：别的命令仍然搜得到（不是把表清空了）', (await palState()).items > 0, true);
  t('反向验证：/rename 还能带参数提示',
    (await palState()).foot.indexOf('/rename') >= 0, true);
  await typeIn('');

  /* ---- 10c. 模型分组折叠 / 展开 ---- */
  await js(`document.getElementById('btn-model').click()`);
  await sleep(600);
  await js(`(function(){ const q=document.getElementById('mdl-q'); q.value=''; q.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(400);
  const listStat = () => js(`(function(){
    const provs = [].slice.call(document.querySelectorAll('#mdl-list .mdl-prov'));
    return {
      provs: provs.length,
      items: document.querySelectorAll('#mdl-list .mdl-item').length,
      expanded: provs.filter(function(p){ return p.getAttribute('aria-expanded') === 'true'; }).length,
      firstProv: provs[0] ? provs[0].querySelector('.mp-name').textContent.trim() : '',
      firstN: provs[0] ? Number(provs[0].querySelector('.mp-n').textContent) : 0,
      btn: document.getElementById('mdl-collapse').textContent.trim(),
      stored: (function(){ try { return localStorage.getItem('pixelagent.collapsedProvs'); } catch(e){ return 'ERR'; } })()
    };
  })()`);
  const base = await listStat();
  console.log('  ℹ 折叠前: ' + JSON.stringify(base));
  t('模型列表按服务商分组', base.provs >= 2, true);
  t('分组标题是「真按钮」（可点可 Tab）',
    await js(`document.querySelector('#mdl-list .mdl-prov').tagName`), 'BUTTON');
  t('分组标题带 aria-expanded（无障碍/可断言）',
    await js(`document.querySelector('#mdl-list .mdl-prov').getAttribute('aria-expanded')`), 'true');

  // 收起第一组
  await js(`document.querySelector('#mdl-list .mdl-prov').click()`);
  await sleep(400);
  const col1 = await listStat();
  console.log('  ℹ 收起第一组后: ' + JSON.stringify({ items: col1.items, expanded: col1.expanded, stored: col1.stored }));
  t('点分组标题 → aria-expanded 翻成 false', col1.expanded, base.expanded - 1);
  t('收起后行被真的移出 DOM（不是 CSS 藏起来）', base.items - col1.items, base.firstN);
  t('其余分组照常显示（收起是分组级的，不是整表清空）', col1.items > 0, true);
  t('收起状态写进了 localStorage', String(col1.stored).indexOf(base.firstProv) >= 0, true);
  t('按钮文案仍是「全部收起」（还有没收起的组，全收才是「全部展开」）', col1.btn, '全部收起');

  // 反向验证：收起状态要能**撑过一次重渲染**，否则只是"点一下碰巧"
  await js(`(function(){ const q=document.getElementById('mdl-q'); q.value='a'; q.dispatchEvent(new Event('input'));
    q.value=''; q.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(400);
  const col1b = await listStat();
  t('反向验证：重渲染后收起状态仍然生效（是状态驱动的）', col1b.items, col1.items);

  // 再点一次展开回去
  await js(`document.querySelectorAll('#mdl-list .mdl-prov')[0].click()`);
  await sleep(400);
  const exp1 = await listStat();
  t('再点一次展开回原样', exp1.items, base.items);
  t('展开后 localStorage 也清干净了', JSON.parse(exp1.stored || '[]').length, 0);

  // 一键全收 / 全展
  await js(`document.getElementById('mdl-collapse').click()`);
  await sleep(400);
  const colAll = await listStat();
  console.log('  ℹ 全部收起: ' + JSON.stringify({ items: colAll.items, provs: colAll.provs, btn: colAll.btn, stored: colAll.stored }));
  t('一键全收：一行都不剩', colAll.items, 0);
  t('一键全收：所有分组都标成收起', colAll.expanded, 0);
  t('全部收起后按钮变「全部展开」', colAll.btn, '全部展开');
  t('全部收起也落到了 localStorage', JSON.parse(colAll.stored || '[]').length, colAll.provs);

  await js(`document.getElementById('mdl-collapse').click()`);
  await sleep(400);
  const expAll = await listStat();
  t('再点一次恢复全部行数', expAll.items, base.items);
  t('恢复后按钮回到「全部收起」', expAll.btn, '全部收起');
  t('恢复后 localStorage 是空数组', expAll.stored, '[]');

  /* ---- 10d. 模型「测试」真的发一次请求 ---- */
  const testClick = await clickRowOp(effModelName, '测试');
  console.log('  ℹ 点「测试」: ' + testClick);
  t('模型行点「测试」能找到并打开弹框', testClick, 'OK');
  let outSt = { cls: '', txt: '' };
  for (let i = 0; i < 60; i++) {          // 最多等 30 秒
    outSt = await js(`(function(){ const o=document.getElementById('mcfg-out'); return { cls:o.className, txt:o.textContent }; })()`);
    if (outSt.txt && outSt.cls.indexOf('busy') < 0) break;
    await sleep(500);
  }
  console.log('  ℹ 测试输出(class=' + outSt.cls + '): ' + JSON.stringify(String(outSt.txt).slice(0, 220)));
  t('测试输出区不是空的（说明真发了请求，不是一个摆设按钮）', String(outSt.txt).length > 0, true);
  t('测试给出结论（通了 / 不通）', /通了|不通/.test(String(outSt.txt)), true);
  t('结论用的是 ✅/❌ 这种一眼能看懂的标记', /✅|❌/.test(String(outSt.txt)), true);
  t('测试报告了耗时', /秒/.test(String(outSt.txt)), true);
  t('✅确认：默认模型这条链路是通的（跑不通就是真出问题了）', String(outSt.txt).indexOf('✅ 通了'), 0);
  await js(`document.getElementById('mcfg-cancel').click()`);
  await sleep(300);
  t('取消能关掉配置弹框', await js(`document.getElementById('mask-mcfg').classList.contains('hidden')`), true);

  /* ---- 10d-2. 双层浮层时 Esc 必须关**最上面**那一层 ----
     这条抓到过一个真 bug：文档级 keydown 里手写判断顺序时把 mask-mcfg 排在
     mask-model 后面，于是"模型框 + 配置框"两层都开着时按 Esc，
     关掉的是**下面**的模型框，最上面的配置框纹丝不动 —— 用户按 Esc 像没反应。
     ⇒ 现在改成从 DOM 里排（同层 z-index 一样，越靠后越在上面），不再手写顺序。 */
  await clickRowOp(effModelName, '配置');
  await sleep(900);
  // 注意：本文件的 t() 是**严格相等**，不是 JSON 比较 —— 所以这里返回的是标量，
  // 别返回对象/数组去比（那样永远不等，我上一版就踩了）。
  const twoLayer = await js(`(function(){
    var pick = function(id){ var e=document.getElementById(id); return !!(e && !e.classList.contains('hidden')); };
    return pick('mask-model') + '/' + pick('mask-mcfg'); })()`);
  t('前提成立：此刻两层浮层都开着（ true/true 才测得到"关的是哪一层"）', twoLayer, 'true/true');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(400);
  t('Esc 关掉的是最上面的配置框', await js(`document.getElementById('mask-mcfg').classList.contains('hidden')`), true);
  t('Esc 没有连坐把下面的模型框也关了',
    await js(`!document.getElementById('mask-model').classList.contains('hidden')`), true);
  t('Esc 仍然没有误触中途中断', await js(`window.__pixelAborts`), 0);
  await js(`document.getElementById('mask-mcfg').classList.add('hidden')`);
  await js(`document.getElementById('mask-model').classList.add('hidden')`);

  /* ---- 10e. 删光会话 → 主动回主页；删当前但还有别的 → 真加载历史 ---- */
  const DEL_KEEP = 995, DEL_ALL = 994;
  const fileOf = (n) => path.join(__dirname, '..', '.sessions', 'chat-' + n + '.json');
  const writeSess = (n, title) => fs.writeFileSync(fileOf(n), [
    { type: 'session', version: 3, id: 'verify-' + n, timestamp: new Date().toISOString(), cwd: path.join(__dirname, '..') },
    { type: 'message', id: 'u' + n, parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: title }], timestamp: Date.now() } }
  ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  writeSess(DEL_KEEP, '保留会话的历史消息');
  writeSess(DEL_ALL, '待删除的会话');

  const homeState = () => js(`(function(){
    return {
      welcomeHidden: document.getElementById('welcome').classList.contains('hidden'),
      msgs: document.querySelectorAll('#log .m').length,
      logText: document.getElementById('log').textContent,
      toastHidden: document.getElementById('toast').classList.contains('hidden'),
      toastText: document.getElementById('toast').textContent,
      seq: window.__pixel.seq
    };
  })()`);

  // ① 删光 → 回主页。res 里的 sessions:[] 就是"一条都不剩"的契约
  await js(`window.__pixelApplyDelete(${DEL_ALL}, ${JSON.stringify({
    ok: true, removedCurrent: true, current: DEL_ALL, sessions: []
  })})`);
  await sleep(500);
  const h1 = await homeState();
  console.log('  ℹ 删光后: ' + JSON.stringify({ welcomeHidden: h1.welcomeHidden, msgs: h1.msgs, toast: h1.toastHidden ? '(隐藏)' : h1.toastText }));
  t('删光所有会话后，主页真的回来了（#welcome 不再 hidden）', h1.welcomeHidden, false);
  t('删光后时间线是空的', h1.msgs, 0);
  t('删光后提示走 toast（时间线之外，所以主页留得住）', h1.toastHidden, false);
  t('toast 说的是「已移入回收站」', h1.toastText.indexOf('已移入回收站') >= 0, true);
  t('这句提示**没有**被塞进时间线（塞了就会把主页顶掉）', h1.logText.indexOf('已移入回收站'), -1);

  // 反向验证：把老路（addMsg）走一遍，证明它确实会把主页藏掉 ——
  // 否则 toast 方案只是"碰巧通过"，而不是因为绕开了那个坑
  await js(`(function(){ document.getElementById('welcome').classList.remove('hidden');
    window.__pixelAddMsg('step','SYS','> 反向验证用的普通时间线消息'); return 1; })()`);
  await sleep(200);
  t('反向验证：走 addMsg 时主页确实又被藏掉了（正因如此提示才改走 toast）',
    await js(`document.getElementById('welcome').classList.contains('hidden')`), true);
  // 还原成主页状态，免得污染下面的断言
  await js(`window.__pixelApplyDelete(${DEL_ALL}, ${JSON.stringify({
    ok: true, removedCurrent: true, current: DEL_ALL, sessions: []
  })})`);
  await sleep(400);

  // ② 删的是当前会话、但还剩别的 → 必须真把那条会话的历史读出来
  //    （只改 S.seq 是"假切换"：时间线还是空的，用户对着一个空壳）
  t('夹具会话文件已就位', fs.existsSync(fileOf(DEL_KEEP)), true);
  const beforeSeq = await js(`window.pixelAPI.sessions().then(function(r){ return r.current; })`);
  await js(`window.__pixelApplyDelete(${DEL_ALL}, ${JSON.stringify({
    ok: true, removedCurrent: true, current: DEL_KEEP,
    sessions: [{ seq: DEL_KEEP, title: '保留会话' }]
  })})`);
  await sleep(1600);                      // 里面要真读一次会话文件
  const h2 = await homeState();
  console.log('  ℹ 删当前但还剩别的: ' + JSON.stringify({ welcomeHidden: h2.welcomeHidden, msgs: h2.msgs, seq: h2.seq }));
  t('界面切到了剩下的那条会话', h2.seq, DEL_KEEP);
  t('真的把历史读出来了（时间线不是空的）', h2.msgs > 0, true);
  t('时间线里就是那条会话的内容', h2.logText.indexOf('保留会话的历史消息') >= 0, true);
  t('这种情况不显示主页（有内容就不该回欢迎页）', h2.welcomeHidden, true);

  // 清理 + 把"当前会话"还回去
  try { fs.rmSync(fileOf(DEL_KEEP), { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(fileOf(DEL_ALL), { force: true }); } catch (e) { /* ignore */ }
  t('一次性会话文件已清掉', fs.existsSync(fileOf(DEL_KEEP)) || fs.existsSync(fileOf(DEL_ALL)), false);
  if (typeof beforeSeq === 'number') { await js(`window.__pixelOpenSession(${beforeSeq})`); await sleep(800); }
  t('当前会话已还回原来那条',
    await js(`window.pixelAPI.sessions().then(function(r){ return r.current; })`), beforeSeq);

  /* ================= 9. 收尾截图 ================= */
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
