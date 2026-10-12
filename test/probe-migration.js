/* ============================================================
   test/probe-migration.js —— 打包版首次运行：老 pi 用户配置迁移断言
   跑法：npm run probe:migration
   ------------------------------------------------------------
   场景：对方机器上装过终端 pi（~/.pi/agent 里有 auth.json /
   models.json）。打包版第一次启动，要**拷贝一份**到 ~/.pixelagent/agent
   （原目录一个字节不能动），并且 ready=true、不再弹欢迎层。
   做法：伪造 USERPROFILE（临时目录），在里面预置假 ~/.pi/agent，
   起真应用后断言四件事：
     ① 拷贝落位（fake/.pixelagent/agent/ 下三件套在）
     ② 原目录 mtime/内容没被改（读回内容与预置一致）
     ③ info.agentDirState.ready = true
     ④ info.firstRun = false（不弹欢迎层）
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 伪造的老家：预置终端 pi 的配置（models.json 里带 key ⇒ 算就绪）
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'px-mig-'));
const legacyAgent = path.join(fakeHome, '.pi', 'agent');
fs.mkdirSync(legacyAgent, { recursive: true });
const LEGACY_MODELS = JSON.stringify({
  providers: { myprov: { api: 'openai-completions', apiKey: 'sk-test-not-real', baseUrl: 'https://example.invalid/v1', models: [{ id: 'demo-model' }] } }
}, null, 2);
fs.writeFileSync(path.join(legacyAgent, 'models.json'), LEGACY_MODELS, 'utf8');
fs.writeFileSync(path.join(legacyAgent, 'auth.json'), '{"test":1}', 'utf8');

process.env.PIXELAGENT_FORCE_PACKAGED = '1';
process.env.PIXELAGENT_HOME = fakeHome;   // 测试钩子（改 USERPROFILE 会崩 Chromium）
process.env.PIXELAGENT_SHOT = '';
require('../main.js');
const { getWindow } = require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(800);

  const js = (code) => win.webContents.executeJavaScript(code);
  let bad = 0;
  const t = (name, got, want) => {
    if (got === want) { console.log('✅ ' + name); return; }
    bad++;
    console.log('❌ ' + name + '  got=' + got + '  want=' + want);
  };

  const newAgent = path.join(fakeHome, '.pixelagent', 'agent');
  t('models.json 拷贝落位', fs.existsSync(path.join(newAgent, 'models.json')), true);
  t('auth.json 拷贝落位', fs.existsSync(path.join(newAgent, 'auth.json')), true);
  t('原 models.json 内容原样（一个字节没动）',
    (() => { try { return fs.readFileSync(path.join(legacyAgent, 'models.json'), 'utf8') === LEGACY_MODELS; } catch (e) { return false; } })(), true);

  const info = await js(`(async()=>{ const i = await window.pixelAPI.info(); return { ready: i.agentDirState.ready, firstRun: i.firstRun }; })()`);
  t('agentDirState.ready = true', info && info.ready, true);
  t('firstRun = false（不弹欢迎层）', info && info.firstRun, false);
  const dbg = await js(`(function(){ var w=document.getElementById('wl-overlay'); return { cls: w.className, display: getComputedStyle(w).display }; })()`);
  console.log('DEBUG welcome ' + JSON.stringify(dbg));
  t('欢迎层保持隐藏',
    await js(`document.getElementById('wl-overlay').classList.contains('hidden')`), true);

  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (e) { /* 同上，删不掉就算了 */ }

  console.log(bad ? '\n❌ FAIL ' + bad : '\n✅ migration 全过');
  app.exit(bad ? 1 : 0);
});
