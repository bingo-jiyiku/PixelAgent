// ============================================================
// test/attach.test.js —— 图片附件「体检 + 落盘」的行为断言
// 跑法：node test/attach.test.js
//
// 这块必须测，因为它同时管三件事：
//   ① 正确性：base64 真的被解出来写成合法图片了没有
//   ② 安全：用户给的文件名可能带 ../ 或盘符，
//      拼接不当就能把文件写到目标目录之外
//   ③ 诚实：坏图必须**带着真实原因**被拒绝，
//      不能像以前那样静默跳过 —— 静默跳过把我的坏夹具
//      伪装成了产品正常，代价是两轮排查
// 三条都靠肉眼看代码很没底，靠断言最直接。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('../attach.js');
const { loadImage } = require('./fixtures/load-image.js');

const TMP = path.join(__dirname, '_att_tmp');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}
// 子串断言（错误原因里带的信息位置不固定，用包含更稳）
function tc(name, hay, needle) {
  const ok = String(hay).indexOf(needle) >= 0;
  if (ok) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   ' + JSON.stringify(String(hay)) + ' 里没有 ' + JSON.stringify(needle));
}
// 安全取下标：断言失败时数组可能是空的，直接 [0].x 会抛异常
// 把整个文件中断掉 —— 那后面的断言就静默不跑了，
// 而"测试没跑完"和"全绿"在报告里长得一模一样。
function at(arr, i) {
  if (Array.isArray(arr)) return arr[i] || {};
  return {};
}
const rs = (x) => String((x && x.reason) || '');

// 合法 PNG 夹具（loadImage 会先验它自己 CRC/inflate 都对，不合格就抛错）
const FIXTURE = loadImage('pixel-24.png');
const PNG_1X1 = FIXTURE.base64;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 这张就是害我查了两轮的坏图：IDAT 的 CRC 与 Adler-32 都是错的。
// 留着它当**负样本** —— 体检必须能把它抓出来。
const BAD_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function save(list) { return A.saveAttachments(list, TMP); }

// 清空临时目录，保证每次跑都是干净起点
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

/* ---------- 0. 先验夹具自己是合法的（否则后面全是在测一张解不开的图） ---------- */
t('夹具是合法 PNG', A.probeImage(Buffer.from(PNG_1X1, 'base64'), 'image/png').ok, true);

/* ---------- 1. probeImage：坏图必须被点名 ---------- */
const badProbe = A.probeImage(Buffer.from(BAD_PNG, 'base64'), 'image/png');
t('坏 PNG 判为不合法', badProbe.ok, false);
tc('坏 PNG 的原因指到 IDAT', badProbe.reason, 'IDAT');
t('坏 PNG 原因不是空话', String(badProbe.reason || '').length > 10, true);
t('好 PNG kind=png', A.probeImage(Buffer.from(PNG_1X1, 'base64'), 'image/png').kind, 'png');
t('空内容不合法', A.probeImage(Buffer.alloc(0), 'image/png').ok, false);
t('过短内容不合法', A.probeImage(Buffer.alloc(5), 'image/png').ok, false);
t('认不出的格式不合法', A.probeImage(Buffer.alloc(64, 0x41), 'image/png').ok, false);
tc('认不出的格式给出前 8 字节', A.probeImage(Buffer.alloc(64, 0x41), 'image/png').reason, '41414141');
t('截断的 JPEG 不合法',
  A.probeImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 0)]), 'image/jpeg').ok, false);
{
  // 真 PNG 但 mime 谎报成 jpeg：应当以**字节 magic** 为准，判成 png。
  // （反过来的写法 —— 把 JPEG 头贴在 PNG 前面 —— 那是在造一个畸形容器，
  //   不是"magic 优先"的用例，第一版就写错了。）
  t('magic 优先于 mime 提示', A.probeImage(Buffer.from(PNG_1X1, 'base64'), 'image/jpeg').kind, 'png');
  // 反过来：真 JPEG 谎报 png，也认字节
  const realJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 0), Buffer.from([0xff, 0xd9])]);
  t('JPEG magic 也算数', A.probeImage(realJpeg, 'image/png').kind, 'jpeg');
}

/* ---------- 2. 正常落盘 ---------- */
const r1 = save([{ name: 'shot.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }]).saved;
t('正常 落盘 1 个', r1.length, 1);
t('正常 扩展名 png', path.extname(at(r1, 0).path || ''), '.png');
t('正常 字节数', at(r1, 0).bytes, Buffer.from(PNG_1X1, 'base64').length);
t('正常 mime', at(r1, 0).mime, 'image/png');
t('正常 kind', at(r1, 0).kind, 'png');
t('正常 文件真的在', fs.existsSync(at(r1, 0).path || ''), true);
t('正常 内容首部是 PNG 魔数',
  (at(r1, 0).path ? fs.readFileSync(at(r1, 0).path).slice(0, 8).equals(PNG_MAGIC) : false), true);
t('正常 没有拒绝项', save([{ name: 'a.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }]).rejected.length, 0);

/* ---------- 3. 坏图落盘必须被拒，且原因能给人看 ---------- */
const rBad = save([{ name: '坏图.png', dataUrl: 'data:image/png;base64,' + BAD_PNG }]);
t('坏图 一个都没落盘', rBad.saved.length, 0);
t('坏图 进了 rejected', rBad.rejected.length, 1);
t('坏图 rejected 保留原名', at(rBad.rejected, 0).name, '坏图.png');
tc('坏图 rejected 带真实原因', rs(at(rBad.rejected, 0)), 'IDAT');

// 好图 + 坏图混在一起：好的不能陪葬
const rMix = save([
  { name: 'good.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 },
  { name: 'bad.png', dataUrl: 'data:image/png;base64,' + BAD_PNG }
]);
t('混批 好的落盘', rMix.saved.length, 1);
t('混批 坏的被拒', rMix.rejected.length, 1);
t('混批 落盘的是好图', /good/.test(path.basename(at(rMix.saved, 0).path || '')), true);

/* ---------- 4. 安全：文件名带 ../ 不能跑出目录 ---------- */
const OUT = path.resolve(TMP);
const r2 = save([{ name: '../../../../evil.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }]).saved;
t('穿越 仍然落盘', r2.length, 1);
t('穿越 仍在目标目录内', path.dirname(path.resolve(at(r2, 0).path || '.')) === OUT, true);
t('穿越 文件名里没有路径分隔', /[\\/]/.test(path.basename(at(r2, 0).path || '')), false);

/* ---------- 5. 安全：文件名带 Windows 盘符 ---------- */
const r3 = save([{ name: 'C:\\Windows\\evil.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }]).saved;
t('盘符 仍在目标目录内', path.dirname(path.resolve(at(r3, 0).path || '.')) === OUT, true);

/* ---------- 6. 安全：文件名带反斜杠与冒号 ---------- */
const r4 = save([{ name: 'a:b\\c/d.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }]).saved;
t('怪异名 仍在目标目录内', path.dirname(path.resolve(at(r4, 0).path || '.')) === OUT, true);

/* ---------- 7. 中文名要保留（不能因为消毒把中文全打成下划线） ---------- */
const r5 = save([{ name: '截图-首页.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }]).saved;
t('中文名保留', /截图-首页/.test(path.basename(at(r5, 0).path || '')), true);

/* ---------- 8. 坏数据要跳过，不能拖垮整批，且各自留下原因 ---------- */
const r6 = save([
  { name: 'ok.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 },
  { name: 'no-dataurl' },
  { name: 'bad.png', dataUrl: '这不是dataURL' },
  { name: 'empty.png', dataUrl: 'data:image/png;base64,' },
  null
]);
t('坏数据只留好的那一个', r6.saved.length, 1);
t('坏数据留下的是好图', /ok/.test(path.basename(at(r6.saved, 0).path || '')), true);
t('坏数据 4 条都有拒绝记录', r6.rejected.length, 4);
t('坏数据 拒绝记录都带原因', r6.rejected.every((x) => x.reason && x.reason.length > 0), true);
tc('没有 dataUrl 的原因', rs(at(r6.rejected, 0)), 'dataUrl');
tc('非 dataURL 的原因', rs(at(r6.rejected, 1)), 'base64');
tc('空图的原因', rs(at(r6.rejected, 2)), '空');
t('null 条目有名字兜底', at(r6.rejected, 3).name, 'img');

/* ---------- 9. 空输入 ---------- */
t('空数组', A.saveAttachments([], TMP).saved.length, 0);
t('null', A.saveAttachments(null, TMP).saved.length, 0);
t('空数组无拒绝', A.saveAttachments([], TMP).rejected.length, 0);

/* ---------- 10. 非图片 mime 也给个合理扩展名（不崩） ---------- */
const r8 = save([{ name: 'weird.xyz', dataUrl: 'data:application/octet-stream;base64,' + PNG_1X1 }]).saved;
t('未知 mime 落 bin', path.extname(at(r8, 0).path || ''), '.bin');

/* ---------- 11. 超过上限要拒，原因要说清多大 ---------- */
const big = Buffer.alloc(A.MAX_ATTACH_BYTES + 1024);
const r9 = save([{ name: 'huge.png', dataUrl: 'data:image/png;base64,' + big.toString('base64') }]);
t('超限被拒', r9.saved.length, 0);
tc('超限原因带上限', rs(at(r9.rejected, 0)), '上限');

/* ---------- 12. 多次落盘文件名不能撞 ---------- */
const r10 = save([
  { name: 'same.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 },
  { name: 'same.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 }
]).saved;
t('同名两条都落盘', r10.length, 2);
t('同名两条路径不同', at(r10, 0).path !== at(r10, 1).path, true);

/* ---------- 13. 文件名不得出现双重扩展名（probe.png → 不能变 probe.png.png） ---------- */
const r11 = save([
  { name: 'probe.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 },
  { name: 'pic.JPEG', dataUrl: 'data:image/jpeg;base64,' + PNG_1X1 },
  { name: '报告 截图.png', dataUrl: 'data:image/png;base64,' + PNG_1X1 },
  { name: '无扩展名', dataUrl: 'data:image/png;base64,' + PNG_1X1 }
]).saved;
t('双扩展名 4 条都落盘', r11.length, 4);
t('probe.png 只有一个扩展名', /probe\.png$/.test(path.basename(at(r11, 0).path || '')), true);
t('probe.png 没有 .png.png', /\.png\.png$/i.test(path.basename(at(r11, 0).path || '')), false);
t('pic.JPEG 以 mime 为准变成 .jpg', /pic\.jpg$/.test(path.basename(at(r11, 1).path || '')), true);
t('中文名去扩展名仍保留中文', /报告_截图\.png$/.test(path.basename(at(r11, 2).path || '')), true);
t('本来就没扩展名的补上 png', /无扩展名\.png$/.test(path.basename(at(r11, 3).path || '')), true);

/* ---------- 14. 直接对 stripExt 下手（纯函数，边界最清楚） ---------- */
t('stripExt 去 png', A.stripExt('a.png'), 'a');
t('stripExt 去 jpeg', A.stripExt('a.jpeg'), 'a');
t('stripExt 大小写不敏感', A.stripExt('a.PNG'), 'a');
t('stripExt 只去末尾一个', A.stripExt('a.tar.png'), 'a.tar');
t('stripExt 无扩展名原样', A.stripExt('abc'), 'abc');
t('stripExt 全是扩展名不返回空', A.stripExt('.png'), 'img');
t('stripExt 空返回 img', A.stripExt(''), 'img');
t('stripExt 中文', A.stripExt('截图.png'), '截图');

/* ---------- 清理 ---------- */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
