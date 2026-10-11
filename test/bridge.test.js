// ============================================================
// test/bridge.test.js —— pi 命令行参数组装的行为断言
// 跑法：node test/bridge.test.js
//
// 盯的是一类真实踩过的坑：把 "@图片路径" 和问题拼成同一个字符串。
// 那样 pi 会把整串当成一个文件路径，报
//   Error: File not found: E:\...\a.png 这张图里有什么…
// 这种错在界面上看不出来，只会表现为"AI 说找不到文件"，
// 所以必须用断言把「@ 必须是独立参数且排在 prompt 之前」钉住。
// ============================================================
'use strict';

const path = require('path');
const { buildArgs } = require('../pi-bridge');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}

const IMG = 'E:/PixelAgent/shots/01-idle.png';
const IMG_ABS = '@' + path.resolve(IMG);

/* ---------- 1. 最基本：没有附件 ---------- */
const a1 = buildArgs({ prompt: '你好' });
t('无附件 args', JSON.stringify(a1), JSON.stringify(['-p', '--mode', 'json', '你好']));

/* ---------- 2. 有附件：必须是独立 argv ---------- */
const a2 = buildArgs({ prompt: '这张图里有什么？', attachments: [IMG] });
t('附件成为独立参数', a2.indexOf(IMG_ABS) >= 0, true);
t('附件排在 prompt 之前', a2.indexOf(IMG_ABS) < a2.indexOf('这张图里有什么？'), true);
t('prompt 是最后一个', a2[a2.length - 1], '这张图里有什么？');
t('附件路径被解析成绝对路径', a2.indexOf(IMG_ABS) >= 0, true);

/* ---------- 3. 反面对照：绝不能有任何一个参数里同时含路径和问题 ---------- */
// 这一条才是真正盯着那个 bug 的。上面几条换成"拼接实现"也可能蒙对顺序，
// 但拼接实现一定会在某个参数里同时出现文件名和问题文字。
const glued = a2.some((s) => s.indexOf('.png') >= 0 && s.indexOf('这张图里有什么') >= 0);
t('路径与问题没有被拼成一个参数', glued, false);

/* ---------- 4. 多个附件 ---------- */
const a4 = buildArgs({ prompt: '看这两张', attachments: ['E:/a.png', 'E:/b.jpg'] });
t('多附件 第一条', a4.indexOf('@' + path.resolve('E:/a.png')) >= 0, true);
t('多附件 第二条', a4.indexOf('@' + path.resolve('E:/b.jpg')) >= 0, true);
t('多附件 prompt 最后', a4[a4.length - 1], '看这两张');

/* ---------- 5. 空附件数组不该产生 @ 参数 ---------- */
const a5 = buildArgs({ prompt: 'x', attachments: [] });
t('空附件不产生 @', a5.some((s) => s.charAt(0) === '@'), false);

/* ---------- 6. 附件里的空值要跳过，不能让 pi 收到孤零零的 "@" ---------- */
const a6 = buildArgs({ prompt: 'x', attachments: ['', null, IMG] });
t('跳过空附件', a6.indexOf('@') , -1);
t('空值不影响有效附件', a6.indexOf(IMG_ABS) >= 0, true);

/* ---------- 7. 顺序契约：选项 -> 会话 -> @文件 -> prompt ---------- */
const a7 = buildArgs({
  prompt: 'P',
  attachments: [IMG],
  sessionFile: 'E:/s/chat-1.json',
  extraArgs: ['--extension', 'E:/ext/todo.ts', '--provider', 'agent-plan']
});
t('会话参数存在', a7.indexOf('E:/s/chat-1.json') >= 0, true);
t('会话参数在 @ 之前', a7.indexOf('--session') < a7.indexOf(IMG_ABS), true);
t('扩展参数在 @ 之前', a7.indexOf('E:/ext/todo.ts') < a7.indexOf(IMG_ABS), true);
t('prompt 仍是最末', a7[a7.length - 1], 'P');

/* ---------- 8. --no-session ---------- */
const a8 = buildArgs({ prompt: 'P', noSession: true, sessionFile: 'E:/should-not-appear.json' });
t('noSession 生效', a8.indexOf('--no-session') >= 0, true);
t('noSession 时不带 session', a8.indexOf('E:/should-not-appear.json'), -1);

/* ---------- 9. 版本/模式前缀固定 ---------- */
const a9 = buildArgs({ prompt: 'P' });
t('以 -p 开头', a9[0], '-p');
t('mode 为 json', a9[1] + ' ' + a9[2], '--mode json');

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
