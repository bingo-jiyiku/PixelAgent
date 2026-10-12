// ============================================================
// test/pathnotes.test.js —— 路径补全的行为断言
// 跑法：node test/pathnotes.test.js   （纯逻辑，不开 Electron）
//
// 对应老板 2026-10-12 的问题：「我给它发了文件夹路径，它说猜不到文件名」。
// 验的是**行为**：真实目录被列出来、不存在的路径被明确告知、
// 不是路径的东西（相对路径 / URL / 时间）绝不误报。
//
// 反向验证记录（改坏实现时下面这些必须红）：
//   · 把正则放宽到能吃相对路径 → 「相对路径不碰」红
//   · 删掉"路径不存在"分支 → 「不存在的路径要明说」红
//   · 冒号后不要求斜杠 → 「T:30 不是路径」红
//   · 去掉 seen 去重 → 「同一个路径说两遍只列一次」红
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathNotes } = require('../path-notes.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}

// ---- 夹具：一个结构已知的临时目录（先自检，再拿去测产品） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'px-pn-'));
const DIR_A = path.join(TMP, '照片库');
fs.mkdirSync(path.join(DIR_A, '旅行'), { recursive: true });
fs.writeFileSync(path.join(DIR_A, '海边.jpg'), 'x');
fs.writeFileSync(path.join(DIR_A, '证件照.png'), 'x');
fs.writeFileSync(path.join(DIR_A, 'readme.txt'), 'x');
const FILE_A = path.join(TMP, '报价单.xlsx');
fs.writeFileSync(FILE_A, 'x');
const DIR_EMPTY = path.join(TMP, '空目录');
fs.mkdirSync(DIR_EMPTY);
// 夹具自检：结构不对就直接抛，别让"夹具坏了"伪装成"产品坏了"
if (!fs.statSync(DIR_A).isDirectory()) throw new Error('夹具坏了：照片库没建起来');
if (fs.readdirSync(DIR_A).length !== 4) throw new Error('夹具坏了：照片库条目数不对');

// ---- 1. 真实目录：列出来，文件夹在前带斜杠 ----
const n1 = pathNotes('帮我把 ' + DIR_A + ' 里面的照片按日期分个类');
t('提到真实目录时有输出', typeof n1 === 'string' && n1.length > 0, true);
t('输出带系统提示头', n1.indexOf('[系统提示：用户消息里提到了下面这些路径') === 0, true);
t('列出的目录名带斜杠（文件夹）', n1.indexOf('旅行/') >= 0, true);
t('列出的文件名不带斜杠', n1.indexOf('海边.jpg') >= 0 && n1.indexOf('海边.jpg/') < 0, true);
t('文件夹排在文件前面（旅行/ 在 海边.jpg 之前）', n1.indexOf('旅行/') < n1.indexOf('海边.jpg'), true);
t('总数照实说（共 4 项）', n1.indexOf('共 4 项') >= 0, true);

// ---- 2. 文件路径：说清是文件不是文件夹 ----
const n2 = pathNotes('看看 ' + FILE_A + ' 里有什么');
t('文件路径被识别', n2.indexOf(FILE_A) >= 0, true);
t('明确说这是一个文件', n2.indexOf('（这是一个文件，不是文件夹）') >= 0, true);

// ---- 3. 不存在的路径：明说"别猜"（反向验证点：删掉这分支会红） ----
const FAKE = path.join(TMP, '不存在的目录xyz');
const n3 = pathNotes('读取 ' + FAKE + ' 的数据');
t('不存在的路径也有输出', typeof n3 === 'string' && n3.length > 0, true);
t('不存在的路径要明说（不让模型猜）', n3.indexOf('（这个路径不存在或读不了') >= 0, true);
t('不存在分支带着"别猜"的指令', n3.indexOf('别猜里面有什么') >= 0, true);

// ---- 4. 没有路径：一个字都不加（别每轮都浪费 token） ----
t('纯对话不触发', pathNotes('你好，今天天气怎么样'), '');
t('空文本不触发', pathNotes(''), '');
t('null/undefined 不炸', pathNotes(null), '');
t('undefined 不炸', pathNotes(undefined), '');

// ---- 5. 不是路径的东西绝不误报（反向验证点：正则放宽会红） ----
t('相对路径不碰', pathNotes('把 photos 里的图整理一下'), '');
t('URL 不碰', pathNotes('看看 https://example.com/a/b/c 这个站点'), '');
t('冒号后不是斜杠的不算路径（T:30）', pathNotes('会议 T:30 开始，别忘了'), '');
t('时间比例不误报（16:9）', pathNotes('按 16:9 裁一下图'), '');

// ---- 6. 尾巴上的标点/斜杠不算路径的一部分 ----
const n6 = pathNotes('帮我看看 ' + DIR_A + '。');
t('中文句号不吞掉路径', n6.indexOf('共 4 项') >= 0, true);
const n6b = pathNotes('帮我看看 ' + DIR_A + '\\，谢了');
t('反斜杠+逗号不吞掉路径', n6b.indexOf('共 4 项') >= 0, true);
// 正斜杠写法（用户从资源管理器地址栏复制的就是这种）
const n6c = pathNotes('看看 ' + DIR_A.replace(/\\/g, '/') + ' 谢谢');
t('正斜杠路径也认', n6c.indexOf('共 4 项') >= 0, true);

// ---- 7. 同一个路径说两遍只列一次（反向验证点：去掉 seen 会红） ----
const n7 = pathNotes(DIR_A + ' 和 ' + DIR_A + ' 都看看');
t('同一个路径只出现一次', n7.split(DIR_A + '（文件夹').length - 1, 1);

// ---- 8. 空目录：明说是空文件夹 ----
const n8 = pathNotes('看看 ' + DIR_EMPTY);
t('空文件夹标出来', n8.indexOf('（空文件夹）') >= 0, true);
t('空目录也报 0 项', n8.indexOf('共 0 项') >= 0, true);

// ---- 9. 路径数量封顶 4 个，多的照实说 ----
const many = [];
for (let i = 0; i < 6; i++) {
  const d = path.join(TMP, 'd' + i);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'f.txt'), 'x');
  many.push(d);
}
const n9 = pathNotes(many.join(' 和 '));
t('最多列 4 个路径', (n9.match(/（文件夹，共 1 项）/g) || []).length, 4);
t('没列的路径数量照实说', n9.indexOf('还有 2 个路径没列') >= 0, true);

// ---- 10. 大小写不同的同一个路径只列一次（Windows 路径不区分大小写） ----
const n10 = pathNotes(DIR_A + ' ' + DIR_A.toLowerCase());
t('大小写不同也算同一个路径', n10.split('（文件夹').length - 1, 1);

// ---- 清理 ----
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 删不掉算了 */ }

console.log(pass ? '' : '');
if (fail) { console.log('\n❌ pathnotes FAIL ' + fail + ' / PASS ' + pass); process.exit(1); }
console.log('✅ pathnotes 全过（' + pass + ' 条）');
