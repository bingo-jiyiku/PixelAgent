/* ============================================================
   test/probe-exportfmt.js —— 导出格式一次性迁移（html → md）断言
   跑法：npm run probe:exportfmt
         （内部会跑两遍：默认=升级场景，--keep=主动选过 html 的场景）

   老板 2026-10-12：「我希望它导出会话是导出成 MD 格式的，不是 html」。
   光把 CFG_DEFAULTS 改默认值**不生效** —— loadCfg 尊重老配置里已存在的键，
   公司机器上 .pixelagent.json 明明白白写着 "html"，界面永远停在 html。
   所以 loadCfg 里做了一次性迁移，并打 cfgMigratedMd 标记。

   两个场景都必须过，否则就是「半条迁移」：
     A（无参数）：老配置 exportFormat=html、无标记 → 启动后变 md，且落盘，
        其它键（enterToSend 等）不许被迁移弄丢。
     B（--keep）：exportFormat=html 且带标记（用户主动选回过 html）
        → 必须**保持 html**。这条是标记的反向验证：
        没有它，"迁移条件里少了 !cfgMigratedMd" 这种退化永远发现不了。

   环境隔离：PIXELAGENT_FORCE_PACKAGED + PIXELAGENT_HOME + app.setPath('userData')
   三件套，保证读写都在临时目录里，绝不碰真机的 %APPDATA%\PixelAgent。
   ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const KEEP = process.argv.includes('--keep');   // 场景 B：用户主动选回过 html

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'px-ef-'));
const fakeUserData = path.join(fakeHome, 'userdata');
fs.mkdirSync(fakeUserData, { recursive: true });
const cfgFile = path.join(fakeUserData, 'pixelagent.json');
// 预置老配置。除了 exportFormat 再带一个 enterToSend:false ——
// 迁移要动配置，但不能把别的键弄丢（saveCfg 写丢键的话这条会红）。
const preset = KEEP
  ? { exportFormat: 'html', cfgMigratedMd: true, enterToSend: false }
  : { exportFormat: 'html', enterToSend: false };
fs.writeFileSync(cfgFile, JSON.stringify(preset, null, 2), 'utf8');

process.env.PIXELAGENT_FORCE_PACKAGED = '1';
process.env.PIXELAGENT_HOME = fakeHome;    // 测试钩子（改 USERPROFILE 会崩 Chromium）
process.env.PIXELAGENT_SHOT = '';
app.setPath('userData', fakeUserData);     // 必须在 require main.js 之前（它在顶层读 userData）

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

  let bad = 0;
  const t = (name, got, want) => {
    if (got === want) { console.log('✅ ' + name); return; }
    bad++;
    console.log('❌ ' + name + '  got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want));
  };

  // 注意 pi:cfg 的返回是 { ok, cfg: {...}, accents, personas, ... } ——
  // 真设置在 .cfg 里（第一版探针直接读顶层，全读成 undefined，
  // 而盘上断言明明全绿：又是"测试自己错了"伪装成"产品坏了"）。
  const r = await win.webContents.executeJavaScript(`window.pixelAPI.cfg()`);
  const c = (r && r.cfg) || {};
  console.log('  ℹ 场景 ' + (KEEP ? 'B(带标记保持 html)' : 'A(老 html 升级 md)') +
              ' 读回配置: ' + JSON.stringify({ exportFormat: c.exportFormat, cfgMigratedMd: c.cfgMigratedMd, enterToSend: c.enterToSend }));

  if (KEEP) {
    t('带标记的老 html 配置保持 html（用户主动选的要尊重）', c.exportFormat, 'html');
    t('标记原样读回', c.cfgMigratedMd, true);
  } else {
    t('老 html 配置被升级成 md', c.exportFormat, 'md');
    t('迁移标记已打上', c.cfgMigratedMd, true);
    t('其它键没被迁移弄丢（enterToSend 仍是 false）', c.enterToSend, false);
  }
  // 内存里对了不算数，得真的落盘 —— 否则下次启动又回 html
  const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  t('落盘的 exportFormat 与内存一致', onDisk.exportFormat, c.exportFormat);
  if (!KEEP) {
    t('落盘的配置里带迁移标记', onDisk.cfgMigratedMd, true);
    t('落盘的配置里其它键还在', onDisk.enterToSend, false);
  }

  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (e) { /* 删不掉算了 */ }
  console.log(bad ? '\n❌ exportfmt FAIL ' + bad : '\n✅ exportfmt 全过');
  app.exit(bad ? 1 : 0);
});
