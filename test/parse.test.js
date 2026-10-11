// ============================================================
// test/parse.test.js —— todo 结果解析的行为断言
// 跑法：node test/parse.test.js
//
// 里面的样本全部来自**真实抓包**（那次让 pi 真调 todo 工具抓下来的 NDJSON），
// 不是我按印象编的结构。之前就是因为没看真实事件，
// 把 args 从 tool_execution_end 里取，结果工具卡片入参一直渲染成 {}。
//
// 特别说明「标记行」那几条断言：它们专门盯着花括号配平。
// 如果哪天有人图省事把 extractMarked 换成非贪婪正则 /\{[\s\S]*?\}/，
// 这几条会立刻变红 —— 因为 {"todos":[{"id":1}]} 会在第一个 } 就断掉。
// 这个反向验证做过：劣化实现下确实红了。
//
// 另外：所有对 list[i] 的访问都走 at()，不放裸的 list[0].text。
// 原因是一次反向验证时 list 为空，裸访问直接抛 TypeError，
// 整个测试文件当场中断 —— 后面的断言一条没跑，连 PASS/FAIL 汇总都没打。
// 那就是「测试没跑起来」和「全绿」长得一模一样的经典陷阱。
// ============================================================
'use strict';

const P = require('../parse.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}
// 安全取值：拿不到就是 undefined，让断言去判，而不是让脚本崩
function at(list, i) { return (list && list[i]) || {}; }

/* ---------- 1. 真实结构：details 在 ev.result 里（实测就是这个位置） ---------- */
const evReal = {
  type: 'tool_execution_end',
  toolName: 'todo',
  result: {
    content: [{
      type: 'text',
      text: 'Added todo #2: 跑测试\nPIXELTODOS:{"action":"add","todos":[{"id":1,"text":"写 README","done":false},{"id":2,"text":"跑测试","done":false}],"nextId":3}'
    }],
    details: {
      action: 'add',
      todos: [{ id: 1, text: '写 README', done: false }, { id: 2, text: '跑测试', done: false }],
      nextId: 3
    }
  },
  isError: false
};
const r1 = P.todosFromToolResult(evReal);
t('真实结构 known', r1.known, true);
t('真实结构 条数', r1.list.length, 2);
t('真实结构 第一项文本', at(r1.list, 0).text, '写 README');
t('真实结构 第二项 id', at(r1.list, 1).id, 2);
t('真实结构 done 归一化', at(r1.list, 0).done, false);

/* ---------- 2. details 挂在事件顶层（另一条兼容路） ---------- */
const r2 = P.todosFromToolResult({ details: { todos: [{ id: 9, text: '顶层', done: true }] } });
t('顶层 details known', r2.known, true);
t('顶层 details 文本', at(r2.list, 0).text, '顶层');
t('顶层 details done', at(r2.list, 0).done, true);

/* ---------- 3. 没有 details，只能靠文本里的标记（配平扫描） ---------- */
const evMark = {
  toolName: 'todo',
  result: {
    content: [{
      type: 'text',
      text: 'Added todo #7: 深层 {括号} 文本\nPIXELTODOS:{"action":"add","todos":[{"id":7,"text":"深层 {括号} 文本","done":false}],"nextId":8}'
    }]
  }
};
const r3 = P.todosFromToolResult(evMark);
t('标记行 known', r3.known, true);
t('标记行 条数', r3.list.length, 1);
t('标记行 嵌套括号文本完整', at(r3.list, 0).text, '深层 {括号} 文本');
t('标记行 id', at(r3.list, 0).id, 7);

/* ---------- 4. 标记后面还有别的文字，也要能正确收尾 ---------- */
const r4 = P.todosFromToolResult({
  result: { content: [{ type: 'text', text: 'PIXELTODOS:{"todos":[{"id":1,"text":"a","done":true}]}\n（完）' }] }
});
t('标记后有尾巴 known', r4.known, true);
t('标记后有尾巴 done', at(r4.list, 0).done, true);

/* ---------- 5. 字符串字面量里带 { 不能带偏配平 ---------- */
const r5 = P.todosFromToolResult({
  result: {
    content: [{
      type: 'text',
      text: 'PIXELTODOS:{"todos":[{"id":3,"text":"他说 {左括号 还有 }右括号","done":false}],"nextId":4}'
    }]
  }
});
t('字符串内括号 known', r5.known, true);
t('字符串内括号 文本', at(r5.list, 0).text, '他说 {左括号 还有 }右括号');

/* ---------- 6. 人类可读行（最后一道兜底） ---------- */
const r6 = P.todosFromToolResult({
  result: { content: [{ type: 'text', text: '当前待办：\n[x] #1: 已完成的事\n[ ] #2: 没做的事\n' }] }
});
t('人类可读行 known', r6.known, true);
t('人类可读行 条数', r6.list.length, 2);
t('人类可读行 第一项 done', at(r6.list, 0).done, true);
t('人类可读行 第二项 done', at(r6.list, 1).done, false);
t('人类可读行 文本', at(r6.list, 1).text, '没做的事');

/* ---------- 7. 合法的空列表（clear 之后） ---------- */
const r7 = P.todosFromToolResult({ result: { content: [{ type: 'text', text: 'No todos' }] } });
t('No todos known=true', r7.known, true);
t('No todos 空列表', r7.list.length, 0);

/* ---------- 8. 跟 todo 无关的工具结果：known 必须是 false ---------- */
// 这条很重要：known=false 表示「这份结果里没有待办信息」，
// 调用方据此**保留现有列表**。要是这里错报成 true，
// 任何一次普通工具调用都会把界面上的待办抹掉。
const r8 = P.todosFromToolResult({
  toolName: 'bash',
  result: { content: [{ type: 'text', text: 'total 12\ndrwxr-xr-x  5 user  staff  160 Jan 1 00:00 src' }] }
});
t('无关结果 known=false', r8.known, false);
t('无关结果 空', r8.list.length, 0);

/* ---------- 9. 各种空输入不能炸 ---------- */
t('null 输入', P.todosFromToolResult(null).known, false);
t('空对象', P.todosFromToolResult({}).known, false);
t('空文本', P.todosFromToolResult({ result: { content: [] } }).known, false);

/* ---------- 10. extractMarked 直接测 ---------- */
t('extractMarked 无标记', P.extractMarked('普通文本'), null);
t('extractMarked 截取完整对象',
  P.extractMarked('PIXELTODOS:{"a":{"b":1}} 尾巴'),
  '{"a":{"b":1}}');
t('extractMarked 未闭合返回 null', P.extractMarked('PIXELTODOS:{"a":1'), null);

/* ============================================================
   11. inspectUserContent —— 判"图到底进没进请求"
   ------------------------------------------------------------
   下面这些字符串都是**真实抓包**里原样抠出来的，不是编的。
   三种形态就是判定的全部输入，所以断言必须贴着它们写：
   · 好图：   text "<file name=\"…\"></file>\n这张图里是什么？" + image(png)
   · 坏图：   text 末尾多一句
              "[Image omitted: could not be resized below the inline image size limit.]"
              （**没有** image 块）—— 这是 pi 静默丢图的唯一外部证据
   · 不看图的模型：
              "[Current model does not support images. The image will be omitted from this request.]"

   想自己重新抓一份对照（比如 pi 换版本、措辞变了）：
     PI_CODING_AGENT_DIR=E:/PixelAgent/.pi-agent node \
       E:/npm-global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
       -p --mode json --provider agent-plan --model <一个看图的模型> \
       "@<图片路径>" "这张图里是什么？" > /tmp/r.log 2>&1
     node test/analyze-events.js /tmp/r.log      # 看 user 消息构成
     # 再 grep "Image omitted" /tmp/r.log 看 pi 换了措辞没有
   ⚠ 措辞要是变了，这里和 parse.js 的 IMG_OMIT_MARKS 得一起改，
     否则兜底会静默失效 —— 而"静默失效"正是这件事本身要防的东西。
   ============================================================ */

// 11.1 好图：有 image 块、没有标记
const okMsg = P.inspectUserContent([
  { type: 'text', text: '<file name="E:\\PixelAgent\\shots\\01-idle.png"></file>\n这张图里是什么？' },
  { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo' }
]);
t('好图 imgs=1', okMsg.imgs, 1);
t('好图 没有丢图标记', okMsg.omit, null);

// 11.2 坏图：没有 image 块、标记指到 resize
const badMsg = P.inspectUserContent([
  {
    type: 'text',
    text: '<file name="E:\\PixelAgent\\.attachments\\1791689086038-30rr9-probe.png.png"></file>\n这张图里是什么？\n\n[Image omitted: could not be resized below the inline image size limit.]'
  }
]);
t('坏图 imgs=0', badMsg.imgs, 0);
t('坏图 抓到标记', !!(badMsg.omit), true);
t('坏图 标记类型是 resize', badMsg.omit && badMsg.omit.key, 'resize');
t('坏图 标记原文被带出来', badMsg.omit && badMsg.omit.text.indexOf('Image omitted') >= 0, true);

// 11.3 模型不支持看图：标记类型必须是 nomodel（跟 resize 要分得开，
//      因为给用户的建议完全不同：一个叫你换图，一个叫你换模型）
const noModel = P.inspectUserContent([
  { type: 'text', text: '看图\n[Current model does not support images. The image will be omitted from this request.]' },
  { type: 'image', mimeType: 'image/png', data: 'x' }
]);
t('不支持看图 imgs=1', noModel.imgs, 1);
t('不支持看图 标记类型 nomodel', noModel.omit && noModel.omit.key, 'nomodel');

// 11.4 content 直接是字符串（老形态 / 简化事件）也要吃
const strForm = P.inspectUserContent('看图\n[Image omitted: could not be resized below the inline image size limit.]');
t('字符串形态 抓到标记', strForm.omit && strForm.omit.key, 'resize');
t('字符串形态 imgs=0', strForm.imgs, 0);

// 11.5 多张图要数全，不能只数第一张
const two = P.inspectUserContent([
  { type: 'text', text: '对比一下' },
  { type: 'image', mimeType: 'image/png', data: 'a' },
  { type: 'image', mimeType: 'image/jpeg', data: 'b' }
]);
t('两张图 imgs=2', two.imgs, 2);

// 11.6 空的 / 脏的输入不能炸
t('字符串空 imgs=0', P.inspectUserContent('').imgs, 0);
t('数组空 imgs=0', P.inspectUserContent([]).imgs, 0);
t('null imgs=0', P.inspectUserContent(null).imgs, 0);
t('含 null 项不炸', P.inspectUserContent([null, { type: 'image', data: 'x' }]).imgs, 1);
t('未知块类型被忽略', P.inspectUserContent([{ type: 'zzz' }]).imgs, 0);

// 11.7 边界：标记必须以**方括号形式**出现才算，光有单词不算
//      （否则 AI 在回答里提一句 "Image omitted" 就能触发误报）
t('无方括号的提及不匹配', !!P.inspectUserContent([{ type: 'text', text: '我们讨论一下 Image omitted 这个行为的成因' }]).omit, false);
t('方括号形式的才匹配', !!P.inspectUserContent([{ type: 'text', text: '[Image omitted: xxx]' }]).omit, true);
// 已知局限（诚实记下来）：用户如果自己手打一模一样的方括号句子，会被误判成丢图。
// 这个取舍可以接受 —— 标记只投在 **user 消息** 上（pi 用 @路径 拼出来的那段），
// 不判 assistant 回答，所以代价只是极小概率的一句多余提示，不是漏报。
// 反过来（漏报）才是贵的：用户以为图发出去了、AI 却在瞎猜。

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
