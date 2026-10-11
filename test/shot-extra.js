// test/shot-extra.js —— 补充验收截图：切到 FILES / TOOLS 两个 tab 各拍一张
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.PIXELAGENT_SHOT = '';   // 不自动发消息
require('../main.js');
const { getWindow } = require('../main.js');

const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  const f = path.join(OUT, name);
  fs.writeFileSync(f, img.toPNG());
  console.log('截图已保存:', f, fs.statSync(f).size, 'bytes');
}

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { await sleep(200); win = getWindow(); }
  if (!win) { console.log('❌ 窗口没建起来'); app.exit(1); return; }
  await new Promise((res) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', res);
    else res();
  });
  await sleep(1800);

  await win.webContents.executeJavaScript(
    `document.querySelector('.rtab[data-tab="files"]').click()`);
  await sleep(1000);
  await shoot(win, '03-files.png');

  await win.webContents.executeJavaScript(
    `document.querySelector('.rtab[data-tab="tools"]').click()`);
  await sleep(400);
  await shoot(win, '04-tools.png');

  // 点左栏第二个会话，验证「历史回放」这条真路径
  const clicked = await win.webContents.executeJavaScript(
    `(function(){var s=document.querySelectorAll('#session-list .sess'); if(s[1]){s[1].click(); return s[1].textContent;} return 'NONE';})()`);
  console.log('点了会话:', clicked);
  await sleep(1500);
  await shoot(win, '05-history.png');

  // 验证命令面板（/ 开头）
  await win.webContents.executeJavaScript(
    `(function(){var i=document.getElementById('input'); i.focus(); i.value='/'; i.dispatchEvent(new Event('input')); return 1;})()`);
  await sleep(500);
  await shoot(win, '06-palette.png');

  // 验证文件引用（@ 开头）
  await win.webContents.executeJavaScript(
    `(function(){var i=document.getElementById('input'); i.value='@p'; i.dispatchEvent(new Event('input')); return 1;})()`);
  await sleep(500);
  await shoot(win, '07-ref.png');

  // 模型 / 思考档位选择器（真拉 pi --list-models，冷启动慢，要等够）
  await win.webContents.executeJavaScript(`document.getElementById('btn-model').click()`);
  for (let i = 0; i < 40; i++) {
    const n = await win.webContents.executeJavaScript(
      `document.querySelectorAll('#mdl-list .mdl-item').length`);
    if (n > 0) { console.log('模型列表已就绪，条目数 =', n); break; }
    await sleep(500);
  }
  await sleep(500);
  await shoot(win, '09-model.png');
  await win.webContents.executeJavaScript(`document.getElementById('mdl-x').click()`);

  console.log('✅ 补充截图完成');
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
