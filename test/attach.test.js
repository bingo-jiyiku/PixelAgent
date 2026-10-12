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

/* ============================================================
   15. saveFiles —— 非图片附件落盘（老板 2026-10-12「为什么不能直接把文件拖进去」）
   ------------------------------------------------------------
   为什么不能拿图片那套凑合：saveAttachments 会跑 probeImage 体检，非图片一律被
   当"认不出图片格式"拒掉。老板拖进来的是 PDF，走它必然被拒，理由还驴唇不对马嘴。
   ============================================================ */
const saveF = (list) => A.saveFiles(list, TMP);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', 'utf8');

/* 15.1 bytes 落盘：内容要对、扩展名要跟原名（.pdf 必须留住 —— pi 认扩展名） */
const rf1 = saveF([{ name: '梦甜甜&Fan江山印6栋6-4平面布置3.pdf', mime: 'application/pdf', bytes: PDF_BYTES }]);
t('saveFiles 存下来了', at(rf1.saved, 0).path ? true : false, true);
t('saveFiles 内容字节数对', at(rf1.saved, 0).bytes, PDF_BYTES.length);
t('saveFiles 落盘内容一模一样',
  at(rf1.saved, 0).path ? fs.readFileSync(at(rf1.saved, 0).path).equals(PDF_BYTES) : false, true);
t('saveFiles 扩展名留住 .pdf', /\.pdf$/.test(path.basename(at(rf1.saved, 0).path || '')), true);
t('saveFiles 名字里的 & 没有泄漏到磁盘名', /&/.test(path.basename(at(rf1.saved, 0).path || '')), false);
t('saveFiles 回给界面的是用户原名', at(rf1.saved, 0).name, '梦甜甜&Fan江山印6栋6-4平面布置3.pdf');
t('saveFiles 中文名保留在磁盘名里', /梦甜甜/.test(path.basename(at(rf1.saved, 0).path || '')), true);

/* 15.2 mime 优先于原名扩展名（原名可能骗人） */
const rf2 = saveF([{ name: 'x.txt', mime: 'application/pdf', bytes: PDF_BYTES }]);
t('saveFiles mime 优先 → .pdf', /\.pdf$/.test(path.basename(at(rf2.saved, 0).path || '')), true);

/* 15.3 认不出的 mime → 沿用原扩展名（别把 .docx/.xlsx 这类丢掉） */
const rf3 = saveF([{ name: '报表.xlsx', mime: 'application/octet-stream', bytes: PDF_BYTES }]);
t('saveFiles 陌生 mime 沿用 .xlsx', /\.xlsx$/.test(path.basename(at(rf3.saved, 0).path || '')), true);

/* 15.4 目录穿越：名字带 ../ 和盘符都必须还落在目标目录里 */
const rf4 = saveF([
  { name: '../../evil.pdf', mime: 'application/pdf', bytes: PDF_BYTES },
  { name: 'C:\\Windows\\evil2.pdf', mime: 'application/pdf', bytes: PDF_BYTES },
  { name: '..\\..\\evil3.pdf', mime: 'application/pdf', bytes: PDF_BYTES }
]);
t('saveFiles 穿越 3 条都存了下来', rf4.saved.length, 3);
t('saveFiles 穿越 第一条仍在目录内', path.dirname(path.resolve(at(rf4.saved, 0).path || '.')) === path.resolve(TMP), true);
t('saveFiles 穿越 第二条仍在目录内', path.dirname(path.resolve(at(rf4.saved, 1).path || '.')) === path.resolve(TMP), true);
t('saveFiles 穿越 第三条仍在目录内', path.dirname(path.resolve(at(rf4.saved, 2).path || '.')) === path.resolve(TMP), true);
t('saveFiles 穿越 文件名里没有路径分隔', /[\\/]/.test(path.basename(at(rf4.saved, 0).path || '')), false);

/* 15.5 不该悄悄吞：空内容 / 没有内容 / 超限 都要**带原因**拒掉 */
const rf5 = saveF([
  { name: 'empty.pdf', mime: 'application/pdf', bytes: Buffer.alloc(0) },
  { name: 'nocontent.pdf', mime: 'application/pdf' },
  null
]);
t('saveFiles 三条都拒了', rf5.saved.length, 0);
t('saveFiles 拒的条数对', rf5.rejected.length, 3);
tc('空格原因说清是空的', rs(at(rf5.rejected, 0)), '空');
tc('没内容原因说清没内容', rs(at(rf5.rejected, 1)), '没有内容');
t('null 条目也带原因', String(rs(at(rf5.rejected, 2))).length > 0, true);

const rf6 = saveF([{ name: 'huge.pdf', mime: 'application/pdf', bytes: Buffer.allocUnsafe(A.MAX_FILE_BYTES + 1024) }]);
t('saveFiles 超限被拒', rf6.saved.length, 0);
tc('saveFiles 超限原因带上限', rs(at(rf6.rejected, 0)), '上限');
t('saveFiles 超限原因说清上限是 50M', rs(at(rf6.rejected, 0)).indexOf('50MB') >= 0, true);

/* 15.6 dataUrl 形式也要能存（兼容路径，别只支持 bytes） */
const rf7 = saveF([{ name: 'd.pdf', mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,' + PDF_BYTES.toString('base64') }]);
t('saveFiles 认 dataUrl', at(rf7.saved, 0).bytes, PDF_BYTES.length);
t('saveFiles dataUrl 内容对',
  at(rf7.saved, 0).path ? fs.readFileSync(at(rf7.saved, 0).path).equals(PDF_BYTES) : false, true);

/* 15.7 fileExt 纯函数边界 */
t('fileExt 认图片 mime', A.fileExt('a', 'image/png'), 'png');
t('fileExt 认 pdf mime', A.fileExt('a', 'application/pdf'), 'pdf');
t('fileExt 认 Office 长 mime', A.fileExt('a', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
t('fileExt text/plain 给 txt 而不是 plain', A.fileExt('a', 'text/plain'), 'txt');
t('fileExt 无扩展名文件靠 mime 补上', A.fileExt('报告', 'application/pdf'), 'pdf');
t('fileExt 不认识就用原名', A.fileExt('a.docx', 'application/octet-stream'), 'docx');
t('fileExt 大小写归一', A.fileExt('a.PDF', ''), 'pdf');
t('fileExt 都没有给 bin', A.fileExt('noext', 'application/octet-stream'), 'bin');
t('fileExt 无 mime 无扩展名给 bin', A.fileExt('', ''), 'bin');
t('fileExt 长怪 mime 不硬猜', A.fileExt('', 'application/x-weirdlongsubtype'), 'bin');

/* 15.8 stripAnyExt 边界（不返回空、只去一个） */
t('stripAnyExt 去 pdf', A.stripAnyExt('a.pdf'), 'a');
t('stripAnyExt 只去末尾一个', A.stripAnyExt('a.tar.gz'), 'a.tar');
t('stripAnyExt 无扩展名原样', A.stripAnyExt('abc'), 'abc');
t('stripAnyExt 别返回空串', A.stripAnyExt('.pdf'), 'file');

/* 15.9 🔴 漂移守卫：renderer 那边的 50MB 和这里必须同一个数
   （同一个数字两处各写一遍 = 迟早漂；漂了不会有任何报错，只会让"界面放行、主进程拒收"
     这种最难查的症状出现。核心逻辑那个 `const MAX_FILE_BYTES = …` 直接解析来比。） */
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const mm = /const MAX_FILE_BYTES\s*=\s*([0-9*\s]+);/.exec(rendererSrc);
const rendererMax = mm ? String(mm[1]).split('*').reduce((a, b) => a * Number(String(b).trim()), 1) : NaN;
t('renderer 的 MAX_FILE_BYTES 解析到了', Number.isFinite(rendererMax), true);
t('renderer 与 attach.js 的 50MB 上限一致', rendererMax, A.MAX_FILE_BYTES);

/* ---------- 清理 ---------- */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
