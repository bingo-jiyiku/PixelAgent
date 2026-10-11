/* ============================================================
   test/fixtures/load-image.js —— 测试图片夹具加载器（带自检）
   ------------------------------------------------------------
   为什么要有这层自检：
   上一轮端到端图片验收一直 FAIL（PASS 23 / FAIL 1），
   我把失败归到产品缺陷上查了两轮，真凶却是**夹具本身** ——
   那张手搓的 1×1 PNG：IDAT 的 CRC 是错的（abce3689，应为 5f2c8f77），
   Adler-32 也是错的，zlib.inflate 直接报 "incorrect data check"。
   它压根解不出来，pi 的图片管线当然失败。
   ⇒ 夹具坏了的时候，测试必须**自己先喊出来**，
     否则「夹具不合法」和「产品有问题」在报告里长得一模一样。

   ★ 体检用的是生产代码里的 attach.probeImage —— 不是另写一份。
     两处各写一份的话，哪天产品放宽了校验、夹具还按老规矩卡，
     或者反过来，都会悄悄错开。这里刻意共用同一个函数。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { probeImage, pngProblem, crc32 } = require('../../attach.js');

/** 返回第一个发现的图片问题（没问题返回空串） */
function imageProblem(buf) {
  const r = probeImage(buf, '');
  return r.ok ? '' : r.reason;
}

/** 加载夹具并在不合规时**直接抛错**（抛错 = 测试红，不会被误当成产品失败） */
function loadImage(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
  const buf = fs.readFileSync(p);
  const prob = imageProblem(buf);
  if (prob) {
    throw new Error('图片夹具不合法 [' + p + ']: ' + prob +
      '\n  这是夹具自己的问题，先去修夹具，不要怀疑产品代码。');
  }
  const b64 = buf.toString('base64');
  return {
    path: p,
    buf: buf,
    bytes: buf.length,
    base64: b64,
    dataUrl: 'data:image/png;base64,' + b64
  };
}

module.exports = { loadImage, imageProblem, pngProblem, crc32 };

// `node test/fixtures/load-image.js` 直接把夹具体检一遍
if (require.main === module) {
  const list = ['pixel-24.png'];
  let bad = 0;
  for (const f of list) {
    try {
      const img = loadImage(f);
      console.log('✅ ' + f + '  ' + img.bytes + ' bytes, base64 ' + img.base64.length + ' 字符');
    } catch (e) {
      bad++;
      console.log('❌ ' + e.message);
    }
  }
  process.exit(bad ? 1 : 0);
}
