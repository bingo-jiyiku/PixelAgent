/* ============================================================
   path-notes.js —— 把用户消息里的真实路径补成目录清单（纯逻辑）
   为什么抽出来：main.js 里别的东西都绑着 Electron/Bridge，
   这块只碰 fs，node 下能直接喂断言，不用开 Electron 靠截图猜。
   用法：node   require('./path-notes.js')
        main   const { pathNotes } = require('./path-notes.js');
   ============================================================ */
'use strict';

const fs = require('fs');

/**
 * 扫描文本里的绝对路径，把**真实存在**的目录列成清单拼成一段系统提示。
 *
 * 老板 2026-10-12：「我给它发了文件夹路径，它说猜不到文件名」——
 * 模型没有文件系统视野，用户发一句「D:\照片整理一下」它就只会猜文件名。
 * 主进程顺手 readdir 一份真的给它，比让它编靠谱得多。
 *
 * 三条设计约束：
 * ① 只列不读内容 —— 目录项名字够它选文件了；读文件内容是 pi 的 @file 内联的事，
 *    别在这儿抢戏（否则一个大目录能把上下文烧穿）。
 * ② 不存在的路径也要**说一句**「别猜」—— 不说的话模型照样会编一个文件名出来。
 * ③ 只认绝对路径（盘符 / UNC）。相对路径是 pi 用 cwd 自己就能回答的，不碰。
 *
 * 已知边界（有意接受）：路径里带空格的（「D:\我的照片」）只能匹配到第一个空格前，
 * 会走进「路径不存在」分支 —— 那种就让用户走 @file 附件，不在这儿猜。
 */
function pathNotes(text) {
  const t = String(text || '');
  if (!t) return '';
  // 盘符路径（E:\xxx / E:/xxx）或 UNC 共享路径（\\srv\share）。
  // 两个坑都踩过（测试逼出来的）：
  // ① 冒号后必须紧跟斜杠 —— 否则 "会议 T:30 开始" 会被当成路径；
  // ② 盘符前不能是字母数字（lookbehind）—— 否则 https:// 里的 "s:" 就是盘符；
  // ③ 中文标点不算路径字符 —— 否则 "D:\照片\，谢了" 能把"谢了"一起吃掉。
  const re = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|*?，。；：！？、）】》」』「」【】…—]+/g;
  const found = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(t)) !== null) {
    // 尾巴上的标点不算路径的一部分（「帮我看看 D:\照片。」这种）
    let p = m[0].replace(/[.,;:!?，。；：！？、）)】》」'"]+$/g, '');
    // 尾巴上的斜杠也去掉（"E:\photos\"），但根目录 "E:\" 不能剥成 "E:"（那就 stat 不到了）
    if (p.length > 3) p = p.replace(/[\\/]+$/, '');
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;   // 同一个路径说两遍只列一次
    seen.add(key);
    found.push(p);
  }
  if (!found.length) return '';

  const MAX_PATHS = 4;    // 最多处理 4 个：再多上下文就该爆了
  const MAX_ENTRIES = 80; // 单个目录最多列 80 条，总数照实说
  const notes = [];
  for (const p of found.slice(0, MAX_PATHS)) {
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (!st) {
      notes.push('- ' + p + '（这个路径不存在或读不了 —— 别猜里面有什么，直接告诉用户路径没找到）');
      continue;
    }
    if (!st.isDirectory()) {
      notes.push('- ' + p + '（这是一个文件，不是文件夹）');
      continue;
    }
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { ents = []; }
    // 文件夹排在文件前面，各自按名字排 —— 用户问"里面有什么"时通常先想看目录结构
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name + '/').sort();
    const files = ents.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
    const all = dirs.concat(files);
    const shown = all.slice(0, MAX_ENTRIES);
    notes.push('- ' + p + '（文件夹，共 ' + ents.length + ' 项' +
      (ents.length > shown.length ? '，下面列前 ' + shown.length + ' 个' : '') + '）：');
    if (!shown.length) notes.push('    （空文件夹）');
    for (const n of shown) notes.push('    ' + n);
  }
  if (found.length > MAX_PATHS) {
    notes.push('（还有 ' + (found.length - MAX_PATHS) + ' 个路径没列，用户问到了再答）');
  }
  if (!notes.length) return '';
  return '[系统提示：用户消息里提到了下面这些路径，以下是它们的真实情况。' +
         '照着列给用户看，不要猜文件名；用户要读哪个文件再 @ 它]\n' + notes.join('\n');
}

module.exports = { pathNotes };
