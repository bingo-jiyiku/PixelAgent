/* ============================================================
   attach.js —— 图片附件：体检 + 落盘（纯 Node，零依赖）
   ------------------------------------------------------------
   为什么必须有这一步：pi 只接受**文件路径**（@path），
   不接受界面里那种 dataURL。所以界面传来的 base64 必须先写盘。

   为什么文件名自己生成、不用用户给的名字：
   用户提供的名字可能带 ../ 或盘符，直接拼进路径就能把文件写到目录外。
   这里一律"时间戳-随机数-消毒后的原名"，路径永远不会跑出目标目录。

   ★ 为什么要做图片体检（probeImage）：
   上一轮端到端图片验收红了两轮，我一直在查产品，真凶是**测试夹具**——
   一张手搓的 1×1 PNG，IDAT 的 CRC 和 Adler-32 都是错的，zlib 解不开。
   而 pi 遇到解不开的图**不会报错**，它会把图片块悄悄丢掉，
   只在文本里塞一句 "[Image omitted: could not be resized ...]"，
   界面上完全看不出「图没发出去」。
   ⇒ 两层防护，这是第一层（发之前）：解不出来的图直接拦下来、
     把真实原因告诉用户，别浪费一次模型调用，也别让它伪装成成功。
      第二层在 renderer.js（发之后）：读 pi 的 omits 标记再兜一次。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ATTACH_BYTES = 16 * 1024 * 1024;
// 非图片附件的上限（和 renderer 里 MAX_FILE_BYTES 必须一致 —— 那边是给用户看的门，
// 这里是最后一道防线。verify-features 里有一条断言专门盯这两个数别漂）。
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
};

// 只留字母数字、点、下划线、连字符和中文，其余压成下划线；开头的点去掉（防隐藏/穿越）
function safeBase(name) {
  return String(name || 'img')
    .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]/g, '_')
    .replace(/^\.+/, '')
    .slice(-40) || 'img';
}

// 去掉末尾自带的图片扩展名 —— 否则 probe.png 会被拼成 probe.png.png。
// 双重扩展名本身不致命（pi 照样能读），但界面上显示难看，
// 而且有些按扩展名判类型的下游会犯迷糊。扩展名一律以 mime 为准。
function stripExt(base) {
  const s = String(base || '').replace(/\.(png|jpe?g|webp|gif|bmp|svg|avif|bin)$/i, '');
  return s || 'img';
}

/* ============================================================
   图片体检
   ============================================================ */

// CRC-32（PNG 标准表），不引依赖自己算
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let r = 0xffffffff;
  for (let i = 0; i < buf.length; i++) r = CRC_TABLE[(r ^ buf[i]) & 0xff] ^ (r >>> 8);
  return (r ^ 0xffffffff) >>> 0;
}

const SIG = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  gif87: Buffer.from('GIF87a', 'ascii'),
  gif89: Buffer.from('GIF89a', 'ascii'),
  bmp: Buffer.from([0x42, 0x4d])
};

/**
 * PNG 深度体检：签名 + 每个 chunk 的 CRC + IDAT 能不能 inflate。
 * 只查前 8 字节签名是不够的 —— 我那张害人的坏图签名就是对的，
 * 坏在 IDAT 的 CRC 与 Adler-32。
 * 返回问题描述，没问题返回 ''。
 */
function pngProblem(buf) {
  if (buf.length < 16) return '文件太短，不像 PNG';
  if (!buf.slice(0, 8).equals(SIG.png)) return 'PNG 签名不对';

  let o = 8;
  const idatParts = [];
  let sawIEND = false;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    if (o + 12 + len > buf.length) return 'chunk 长度越界（文件被截断？）';
    const type = buf.slice(o + 4, o + 8).toString('ascii');
    const data = buf.slice(o + 8, o + 8 + len);
    const crc = buf.readUInt32BE(o + 8 + len);
    const calc = crc32(buf.slice(o + 4, o + 8 + len));
    if (calc !== crc) {
      return type + ' chunk 的 CRC 不对（' + crc.toString(16) + ' ≠ ' + calc.toString(16) + '）';
    }
    if (type === 'IHDR') {
      const w = data.readUInt32BE(0), h = data.readUInt32BE(4);
      if (!w || !h) return 'IHDR 宽高为 0';
    }
    if (type === 'IDAT') idatParts.push(data);
    if (type === 'IEND') { sawIEND = true; break; }
    o += 12 + len;
  }
  if (!idatParts.length) return '没有 IDAT（图片数据缺失）';
  if (!sawIEND) return '没有 IEND（文件不完整）';
  // 多个 IDAT 要拼起来再解（真实编码器会分片）
  try {
    const zlib = require('zlib');
    const inf = zlib.inflateSync(Buffer.concat(idatParts));
    if (!inf.length) return 'IDAT 解出来是空的';
  } catch (e) {
    return 'IDAT 解不开（' + e.message + '）';
  }
  return '';
}

/** 从 mime 猜格式名 */
function kindOf(buf, mimeHint) {
  const b = buf;
  if (b.length >= 8 && b.slice(0, 8).equals(SIG.png)) return 'png';
  if (b.length >= 3 && b.slice(0, 3).equals(SIG.jpeg)) return 'jpeg';
  if (b.length >= 6 && (b.slice(0, 6).equals(SIG.gif87) || b.slice(0, 6).equals(SIG.gif89))) return 'gif';
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (b.length >= 2 && b.slice(0, 2).equals(SIG.bmp)) return 'bmp';
  const head = b.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.indexOf('<svg') >= 0)) return 'svg';
  if (b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp') return 'avif';
  const m = /^image\/([a-z0-9.+-]+)$/.exec(String(mimeHint || '').toLowerCase());
  if (m && (m[1] === 'jpeg' || m[1] === 'jpg')) return 'jpeg';
  return '';
}

/**
 * 体检一块图片字节，返回 {ok, kind, reason}。
 * ok=false 时 reason 是**给人看的**真实原因（要能拿到界面上显示）。
 */
function probeImage(buf, mimeHint) {
  if (!buf || !buf.length) return { ok: false, kind: '', reason: '内容是空的' };
  if (buf.length < 24) {
    return { ok: false, kind: '', reason: '只有 ' + buf.length + ' 字节，太短，不是一张真图片' };
  }

  const kind = kindOf(buf, mimeHint);
  if (!kind) {
    return { ok: false, kind: '', reason: '认不出图片格式（前 8 字节 ' + buf.slice(0, 8).toString('hex') + '）' };
  }

  if (kind === 'png') {
    const p = pngProblem(buf);
    if (p) return { ok: false, kind: kind, reason: p };
  }
  // jpeg 只查首尾：SOI 开头 + EOI 结尾。
  // 完整校验要解 Huffman，性价比不高 —— pi 能读的图它自己会读。
  if (kind === 'jpeg') {
    if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
      return { ok: false, kind: kind, reason: 'JPEG 结尾不是 EOI 标记（文件被截断？）' };
    }
  }
  return { ok: true, kind: kind, reason: '' };
}

/**
 * 把 [{name, dataUrl}] 写盘。
 *
 * 返回值：{ saved:[{path, bytes, mime, kind, name}], rejected:[{name, reason}] }
 * ★ 为什么要 rejected 而不是像以前那样静默 continue：
 *   「静默跳过」把我的坏夹具伪装成了产品正常，代价是两轮排查。
 *   调用的地方必须能把这些原因显示给用户。
 */
function saveAttachments(list, dir) {
  const saved = [];
  const rejected = [];
  if (!Array.isArray(list) || !list.length) return { saved: saved, rejected: rejected };
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return { saved: saved, rejected: [{ name: '(全部)', reason: '目录建不出来: ' + e.message }] }; }

  for (const it of list) {
    const nm = (it && it.name) || 'img';
    if (!it || typeof it.dataUrl !== 'string') { rejected.push({ name: nm, reason: '没有 dataUrl' }); continue; }

    const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]*)$/i.exec(it.dataUrl);
    if (!m) { rejected.push({ name: nm, reason: '不是 base64 dataURL' }); continue; }

    const mime = m[1].toLowerCase();
    const ext = MIME_EXT[mime] || 'bin';

    let buf;
    try { buf = Buffer.from(m[2], 'base64'); }
    catch (e) { rejected.push({ name: nm, reason: 'base64 解不开' }); continue; }

    if (!buf.length) { rejected.push({ name: nm, reason: '图片内容是空的' }); continue; }
    if (buf.length > MAX_ATTACH_BYTES) {
      rejected.push({ name: nm, reason: '超过 ' + Math.round(MAX_ATTACH_BYTES / 1048576) + 'MB 上限（实际 ' + (buf.length / 1048576).toFixed(1) + 'MB）' });
      continue;
    }

    // ★ 体检：解不出来的图别往 pi 手里递，否则它静默丢图、界面看不出
    const probe = probeImage(buf, mime);
    if (!probe.ok) { rejected.push({ name: nm, reason: '图片本身有问题：' + probe.reason }); continue; }

    const fname = (Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '-' + stripExt(safeBase(nm)))
      .slice(0, 80) + '.' + ext;
    const full = path.join(dir, fname);

    // 双保险：生成完之后再确认一次没跑出目录（文件名被消毒过，正常不会触发）
    if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
      rejected.push({ name: nm, reason: '文件名不合法（解析后跑出了附件目录）' });
      continue;
    }

    try { fs.writeFileSync(full, buf); }
    catch (e) { rejected.push({ name: nm, reason: '写盘失败: ' + e.message }); continue; }

    saved.push({ path: full, bytes: buf.length, mime: mime, kind: probe.kind, name: nm });
  }

  return { saved: saved, rejected: rejected };
}

// 常见**非图片** mime → 扩展名。
// ★ 为什么必须有这张表（而不是靠"从 mime 反推"）：MIME_EXT 只管图片，
//   于是 application/pdf 会被当成"不认识的 mime"，一路滑到按文件名猜；
//   而 Office 那串 application/vnd.openxmlformats-… 反推出来是
//   `.vndopenxmlformats` 这种垃圾。pi 认扩展名，扩展名错了等于把文件弄坏。
const FILE_MIME_EXT = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/octet-stream': '',            // 就是不认识：交给文件名/兜底，别硬猜
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'text/yaml': 'yaml'
};

/**
 * 非图片附件的扩展名，优先级：图片 mime → 常见文档 mime → 原文件名 → 从 mime 反推（从紧）→ bin。
 *
 * ★ 为什么不能只按 mime：PDF/Office 的 mime 五花八门（application/pdf、
 *   application/vnd.openxmlformats-officedocument.wordprocessingml.document…），
 *   而且 **pi 读文件主要认扩展名** —— 落盘时把 .pdf 弄丢就等于把文件弄坏，
 *   用户会收到一段"看不懂这是啥"的乱码而不是他的 PDF。
 * ★ 为什么从 mime 反推要「从紧」（只收 2-5 个纯字母数字）：宽松匹配会把
 *   `text/plain` 推成 `.plain`、把 Office 长 mime 推成 `.vndopenxmlformats`。
 */
function fileExt(name, mime) {
  const m = String(mime || '').toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m];
  if (FILE_MIME_EXT[m]) return FILE_MIME_EXT[m];
  const byName = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  if (byName) return byName[1].toLowerCase();
  const m2 = /^[a-z]+\/([a-z0-9]+)$/.exec(m);
  if (m2 && m2[1].length >= 2 && m2[1].length <= 5) return m2[1];
  return 'bin';
}

// 去掉末尾任意扩展名（saveFiles 要用：原名 report.pdf 先去掉 .pdf 再按算出来的 ext 拼，
// 否则会拼成 report.pdf.pdf）。attach.js 里那个 stripExt 只认图片扩展名，不够用。
function stripAnyExt(s) {
  return String(s || '').replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'file';
}

/**
 * 把**任意文件**写盘：saveAttachments 之外的另一条路。
 *
 * ★ 为什么不复用 saveAttachments：
 *   那个函数是为图片写的 —— 它跑 probeImage 体检，非图片一律被当"认不出图片格式（前 8 字节 …）"
 *   拒掉。老板拖进来的 PDF 走它必然被拒，而且理由还是"图片有问题"，纯属驴唇不对马嘴。
 *
 * 入参每个是 { name, mime, bytes|dataUrl }：
 *   · bytes   —— Uint8Array / Buffer（renderer 走 file.arrayBuffer() 拿到的，首选，不用 base64）
 *   · dataUrl —— 兼容 base64 dataURL
 * 返回值同 saveAttachments：{ saved:[{path,bytes,mime,kind,name}], rejected:[{name,reason}] }
 */
function saveFiles(list, dir) {
  const saved = [];
  const rejected = [];
  if (!Array.isArray(list) || !list.length) return { saved: saved, rejected: rejected };
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return { saved: saved, rejected: [{ name: '(全部)', reason: '目录建不出来: ' + e.message }] }; }

  for (const it of list) {
    const nm = (it && it.name) || 'file';
    if (!it) { rejected.push({ name: nm, reason: '空条目' }); continue; }

    let buf = null;
    if (it.bytes && typeof it.bytes.length === 'number') {
      try { buf = Buffer.from(it.bytes); }
      catch (e) { rejected.push({ name: nm, reason: '内容解不开: ' + e.message }); continue; }
    } else if (typeof it.dataUrl === 'string') {
      const m = /^data:([a-z0-9.+/-]+)?;base64,([\s\S]*)$/i.exec(it.dataUrl);
      if (!m) { rejected.push({ name: nm, reason: '不是 base64 dataURL' }); continue; }
      try { buf = Buffer.from(m[2], 'base64'); }
      catch (e) { rejected.push({ name: nm, reason: 'base64 解不开' }); continue; }
    } else {
      rejected.push({ name: nm, reason: '没有内容（bytes / dataUrl 都没有）' });
      continue;
    }

    if (!buf.length) { rejected.push({ name: nm, reason: '内容是空的' }); continue; }
    if (buf.length > MAX_FILE_BYTES) {
      rejected.push({ name: nm, reason: '超过 ' + Math.round(MAX_FILE_BYTES / 1048576) + 'MB 上限（实际 ' + (buf.length / 1048576).toFixed(1) + 'MB）' });
      continue;
    }

    const ext = fileExt(nm, it.mime);
    const fname = (Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '-' + stripAnyExt(safeBase(nm)))
      .slice(0, 80) + '.' + ext;
    const full = path.join(dir, fname);

    if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
      rejected.push({ name: nm, reason: '文件名不合法（解析后跑出了附件目录）' });
      continue;
    }

    try { fs.writeFileSync(full, buf); }
    catch (e) { rejected.push({ name: nm, reason: '写盘失败: ' + e.message }); continue; }

    // name 给的是**用户原名**（含 & 之类），磁盘名是消毒过的那个 —— 界面上要显示原名
    saved.push({ path: full, bytes: buf.length, mime: String(it.mime || ''), kind: 'file', name: nm });
  }

  return { saved: saved, rejected: rejected };
}

module.exports = {
  saveAttachments, saveFiles, probeImage, pngProblem, kindOf, crc32,
  safeBase, stripExt, stripAnyExt, fileExt, MAX_ATTACH_BYTES, MAX_FILE_BYTES, MIME_EXT
};
