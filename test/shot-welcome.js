/* ============================================================
   test/shot-welcome.js —— 首次运行引导（welcome）行为断言 + 截图
   跑法：npm run shot:welcome
   ------------------------------------------------------------
   模拟「对方拿到打包版、机器上什么都没有」：把 USERPROFILE 指到
   临时空目录 + 打包模式开关，这时主进程的 AGENT_DIR 会落在临时
   目录下、没有任何模型配置 ⇒ firstRun=true ⇒ 欢迎层必须出现。
   断言三件事：
     ① 欢迎层出现（打包路径 + firstRun 判定都对）
     ② 点「跳过」后消失
     ③ AGENT_DIR 报的是 ~/.pixelagent/agent（不是开发版的 ~/.pi/agent）
   顺便截图 shots/30-welcome.png 给人看效果。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ★ 两行都必须赶在 require('../main.js') 之前：
//   IS_PACK 和 AGENT_DIR 都是 main.js 加载时就算好的常量。
//   伪造"家"用 PIXELAGENT_HOME（main.js 的测试钩子）——不能改 USERPROFILE，
//   Chromium 读它定位缓存目录，改了直接崩（实测 0x80000003）。
process.env.PIXELAGENT_FORCE_PACKAGED = '1';
process.env.PIXELAGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'px-welcome-'));
process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(1800);   // 等 api.info() 回来触发 showWelcome

  const js = (code) => win.webContents.executeJavaScript(code);
  let bad = 0;
  const t = (name, got, want) => {
    if (got === want) { console.log('✅ ' + name); return; }
    bad++;
    console.log('❌ ' + name + '  got=' + got + '  want=' + want);
  };

  t('首次运行：欢迎层出现', await js(`!document.getElementById('wl-overlay').classList.contains('hidden')`), true);
  t('界面报的配置目录是 ~/.pixelagent/agent',
    await js(`(async()=>{ const i = await window.pixelAPI.info(); return i.agentDir.indexOf('.pixelagent') >= 0; })()`), true);

  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, '30-welcome.png'), img.toPNG());
    console.log('📸 shots/30-welcome.png');
  } catch (e) { console.log('（截图失败，不影响断言：' + e.message + '）'); }

  await js(`document.getElementById('wl-skip').click()`);
  await sleep(250);
  t('点「跳过」：欢迎层消失', await js(`document.getElementById('wl-overlay').classList.contains('hidden')`), true);

  // 数据落点：打包版配置目录应在假 home 下
  const agentDir = path.join(process.env.PIXELAGENT_HOME, '.pixelagent', 'agent');
  t('打包版配置目录已建', fs.existsSync(agentDir), true);

  // 收尾：临时假 home 删掉
  try { fs.rmSync(process.env.PIXELAGENT_HOME, { recursive: true, force: true }); } catch (e) { /* Windows 句柄慢放，删不掉就算了 */ }

  console.log(bad ? '\n❌ FAIL ' + bad : '\n✅ welcome 全过');
  app.exit(bad ? 1 : 0);
});
