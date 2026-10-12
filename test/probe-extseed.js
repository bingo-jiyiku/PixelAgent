/* ============================================================
   test/probe-extseed.js —— 捆绑扩展播种链路断言（真机）
   跑法：npm run probe:extseed

   验「下载安装就可以直接用」这条链路在**新用户**场景下真的通：
     假家目录 + FORCE_PACKAGED + PIXELAGENT_RES=vendor（资源钩子）
     → 起真应用 → 播种 → 断言四件事：
       ① 六个扩展真的落到 ~/.pixelagent/agent/npm/node_modules
       ② settings.json 的 packages 被加性合并，用户原有键一根头发都没少
       ③ 标记文件记了账（下次启动不会重复播种）
     ④ **真跑一次 pi list**（PI_CODING_AGENT_DIR 指到播种后的目录）——
        六个扩展都列出来才算数。这条是实锤：光看文件在盘上不算，
        pi 认不出来等于白捆。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'px-extseed-'));
const fakeUserData = path.join(fakeHome, 'userdata');
const agentDir = path.join(fakeHome, '.pixelagent', 'agent');
fs.mkdirSync(fakeUserData, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
// 预置一个"配过模型"的新用户：models.json 带 key ⇒ ready，不走欢迎层
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
  providers: { 'agent-plan': { api: 'openai-completions', apiKey: 'sk-fake-not-real', baseUrl: 'https://ark.invalid/v3', models: [{ id: 'ark-code-latest' }] } }
}, null, 2), 'utf8');
// 预置用户自己的 settings.json：有两个键 + 一个自己装的扩展（加性合并不许动它们）
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultModel: 'ark-code-latest',
  defaultProvider: 'agent-plan',
  theme: 'dark',
  packages: ['npm:pi-simplify']
}, null, 2), 'utf8');

const SIX = ['pi-background-tasks', 'pi-subagents', 'pi-hermes-memory', 'pi-web-access', 'pi-lens', 'pi-simplify'];

process.env.PIXELAGENT_FORCE_PACKAGED = '1';
process.env.PIXELAGENT_HOME = fakeHome;
// 资源钩子。默认指 vendor/ext-npm（验播种逻辑本身）；
// PIXELAGENT_PROBE_RES 可覆盖成 dist-app/win-unpacked/resources，
// 直接验"打出来的安装包里的扩展库"能不能播种——vendor 对不代表打包配置对
// （extraResources 那条 filter 坑就是 vendor 全对、包裡静默少 9000 文件）。
process.env.PIXELAGENT_RES = process.env.PIXELAGENT_PROBE_RES || path.join(__dirname, '..', 'vendor');
process.env.PIXELAGENT_SHOT = '';
// userData 也必须指到假目录：不然 CONFIG_FILE 和 .ext-seeded.json 会写进真机
// %APPDATA%（第一版探针就这么误写过一份，删都省事）。
app.setPath('userData', fakeUserData);
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

  // 等播种完成（190MB 拷贝，轮询标记文件，最多 120 秒）
  const markerFile = path.join(fakeUserData, '.ext-seeded.json');
  const t0 = Date.now();
  while (!fs.existsSync(markerFile) && Date.now() - t0 < 120000) await sleep(500);
  const seedMs = Date.now() - t0;

  let bad = 0;
  // 数组/对象一律 JSON 比 —— 这探针第一版用 === 比数组，永远不等，六条断言全假红
  // （verify-features 的老教训，换个文件又犯一次）。
  const t = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { console.log('✅ ' + name); return; }
    bad++;
    console.log('❌ ' + name + '  got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want));
  };

  console.log('  ℹ 播种耗时 ' + seedMs + 'ms');
  t('标记文件写下来了（播种跑过了）', fs.existsSync(markerFile), true);

  // ① 六个扩展真的在盘上
  const onDisk = SIX.filter((p) => fs.existsSync(path.join(agentDir, 'npm', 'node_modules', p, 'package.json')));
  t('六个扩展全部落盘', onDisk.length, 6);
  t('落位目录带嵌套依赖（pi-web-access 的 undici 也在）',
    fs.existsSync(path.join(agentDir, 'npm', 'node_modules', 'undici', 'package.json')), true);

  // ② settings.json 加性合并，用户键不动
  const set = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
  t('packages = 用户原有的 + 六个捆绑的（去重后排后面）',
    set.packages, ['npm:pi-simplify'].concat(SIX.filter((p) => p !== 'pi-simplify').map((p) => 'npm:' + p)));
  t('用户的 defaultModel 没被碰', set.defaultModel, 'ark-code-latest');
  t('用户的 theme 没被碰', set.theme, 'dark');

  // 实锤：真跑 pi list，六个扩展都要认出来。
  // ⚠ stdio 绝不能交给 spawnSync 默认的管道 —— 本机沙箱会拦 node 系进程的
  //   管道 spawn（EBUSY，见记忆 2026-10-10 的变量隔离实验）。改开临时文件
  //   把 fd 传给子进程，绕开管道；输出落盘后再读回来断言。
  const nodeExe = process.execPath;   // electron 的 node 模式（和打包版跑 pi 的方式一致）
  const piCli = path.join(__dirname, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  const cliPath = fs.existsSync(piCli) ? piCli : 'E:/npm-global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const outFile = path.join(os.tmpdir(), 'px-pilist-' + process.pid + '.txt');
  const fd = fs.openSync(outFile, 'w');
  const r = spawnSync(nodeExe, [cliPath, 'list'], {
    stdio: ['ignore', fd, fd], timeout: 120000,
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: agentDir
    })
  });
  fs.closeSync(fd);
  let out = '';
  try { out = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* 读不到按空处理 */ }
  try { fs.unlinkSync(outFile); } catch (e) { /* 临时文件删不掉算了 */ }
  console.log('  ℹ pi list spawn: status=' + r.status + ' error=' + (r.error && r.error.message) +
    ' outLen=' + out.length + ' cli=' + cliPath);
  console.log('  ℹ pi list 输出（前 600 字）：\n' + out.slice(0, 600));
  const listed = SIX.filter((p) => out.indexOf(p) >= 0);
  t('pi list 认出全部六个扩展（实锤）', listed.length, 6);
  t('pi list 没报加载错误', /Error|Cannot find|failed/i.test(out), false);

  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (e) { /* 删不掉算了 */ }
  console.log(bad ? '\n❌ extseed 探针 FAIL ' + bad : '\n✅ extseed 探针全过');
  app.exit(bad ? 1 : 0);
});
