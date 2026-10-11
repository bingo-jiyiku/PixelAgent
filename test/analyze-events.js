/**
 * 事件流取证脚本（pi --mode json 的输出）
 * 用法: node test/analyze-events.js <日志文件>
 *
 * 为什么单独写：判「pi 到底有没有真的读到图」这件事，
 * 靠肉眼看 1.5MB NDJSON 不现实，靠猜更不行。这里把关键证据打出来：
 *   1) 事件类型分布（有没有 message / tool_execution）
 *   2) user 消息的 content 里到底有没有 image 块
 *   3) image 块是真带了 base64（而不是只留了个文件名）
 *   4) 最终 assistant 回答的正文
 */
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('用法: node test/analyze-events.js <日志文件>'); process.exit(2); }

const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());

const types = {};
const evs = [];
let bad = 0;
for (const l of lines) {
  let j;
  try { j = JSON.parse(l); } catch (e) { bad++; continue; }
  types[j.type] = (types[j.type] || 0) + 1;
  evs.push(j);
}

console.log('=== 解析情况 ===');
console.log('总行数', lines.length, '| 可解析', evs.length, '| 非 JSON 行', bad);
console.log('=== 事件类型分布 ===');
console.log(JSON.stringify(types, null, 1));

console.log('\n=== user 消息内容构成 ===');
let sawImage = 0, sawBase64 = 0;
for (const j of evs) {
  const m = j.message;
  if (!m || m.role !== 'user') continue;
  const c = m.content;
  if (typeof c === 'string') { console.log('  content = 纯字符串:', JSON.stringify(c.slice(0, 80))); continue; }
  if (!Array.isArray(c)) continue;
  const desc = c.map((x) => {
    if (x && x.type === 'image') {
      sawImage++;
      const len = (x.data || '').length;
      if (len > 100) sawBase64++;
      return 'image(' + (x.mimeType || x.mediaType || '?') + ', base64 ' + len + ' 字符)';
    }
    if (x && x.type === 'text') return 'text(' + String(x.text || '').length + ' 字符)';
    return (x && x.type) || '?';
  });
  console.log('  →', desc.join(' + '));
}

console.log('\n=== 结论 ===');
console.log(sawImage > 0
  ? '✅ 图片作为 image 内容块进入了请求（找到 ' + sawImage + ' 个，其中 ' + sawBase64 + ' 个带真实 base64 数据）'
  : '❌ 请求里没有 image 内容块 —— 图没被读进去');

console.log('\n=== assistant 最终回答 ===');
let last = '';
for (const j of evs) {
  const m = j.message;
  if (!m || m.role !== 'assistant') continue;
  if (!Array.isArray(m.content)) continue;
  const t = m.content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('');
  if (t) last = t;
}
console.log(last || '(没有拿到 assistant 文本)');

// 顺手看看用量：视觉模型吃图的 token 会明显偏高
console.log('\n=== 用量 ===');
for (const j of evs) {
  if (j.type === 'turn_end' && j.message && j.message.usage) {
    console.log(JSON.stringify(j.message.usage));
  }
}
