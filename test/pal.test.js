// ============================================================
// test/pal.test.js —— 命令面板匹配规则的行为断言
// 跑法：node test/pal.test.js
//
// 为什么值得单独测：这类"过滤/排序"错了以后界面**照样能用**，
// 只是永远不给你想要的那条。肉眼看不出来，只能靠断言。
//
// ★ 反向验证（本文件末尾那段）：把匹配规则劣化成"只要字符出现就算"，
//   下面几条必须变红。只对正向全绿负责的断言，等于没写。
//
// 取值一律走 at()，不放裸的 list[0].x —— 一条断言失败把整个文件打断，
// 会让"没跑起来"和"全绿"长得一模一样。
// ============================================================
'use strict';

const Pal = require('../pal.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}
function at(list, i) { return (list && list[i]) || {}; }
function keys(items) { return (items || []).map((x) => x.key).join(','); }

/* ---------- 1. fuzzy：子序列语义 ---------- */
t('[fuzzy] 空查询命中一切（score 0）', Pal.fuzzy('/new', '').score, 0);
t('[fuzzy] 空查询无高亮', Pal.fuzzy('/new', '').marks.length, 0);
t('[fuzzy] 按顺序出现即命中', !!Pal.fuzzy('rename', 'rn'), true);
t('[fuzzy] 顺序反了不命中', Pal.fuzzy('rename', 'nr'), null);
t('[fuzzy] 字符不存在不命中', Pal.fuzzy('rename', 'z'), null);
t('[fuzzy] 大小写不敏感', !!Pal.fuzzy('Rename', 'rename'), true);
t('[fuzzy] 命中下标回传正确', JSON.stringify(Pal.fuzzy('rename', 'rn').marks), '[0,2]');
t('[fuzzy] 连续命中分数高于跳跃命中', Pal.fuzzy('rename', 're').score > Pal.fuzzy('rename', 'rn').score, true);
t('[fuzzy] 词首命中额外加分', Pal.fuzzy('name', 'n').score > Pal.fuzzy('aname', 'n').score, true);

/* ---------- 2. segments：切片段（不在这里拼 HTML） ---------- */
const seg1 = Pal.segments('/rename', [1, 2]);
t('[segments] 片段数正确', seg1.length, 3);
t('[segments] 第 0 段未命中', at(seg1, 0).hit, false);
t('[segments] 第 0 段原文是斜杠', at(seg1, 0).t, '/');
t('[segments] 第 1 段命中且是 re', at(seg1, 1).t + '|' + at(seg1, 1).hit, 're|true');
t('[segments] 第 2 段是 name', at(seg1, 2).t, 'name');
t('[segments] 相邻同状态会合并', Pal.segments('abc', [0, 1]).length, 2);
t('[segments] 无命中时只有一段', Pal.segments('abc', []).length, 1);

/* ---------- 3. parseCmdInput：只在第一个空格切 ---------- */
const p1 = Pal.parseCmdInput('/rename 我的会话');
t('[parse] head 是 rename', p1.head, 'rename');
t('[parse] rest 是名字', p1.rest, '我的会话');
t('[parse] key 带斜杠', p1.key, '/rename');
const p2 = Pal.parseCmdInput('/rename 周报 2026 上半年');
t('[parse] 名字里的空格原样保留', p2.rest, '周报 2026 上半年');
const p3 = Pal.parseCmdInput('/');
t('[parse] 只有一个斜杠时 head 为空', p3.head, '');
t('[parse] 只有一个斜杠时 rest 为空', p3.rest, '');
t('[parse] 只有一个斜杠时无空格', p3.hasSpace, false);

/* ---------- 4. rankCommands：真实命令表 ---------- */
const CMDS = [
  { k: '/new', g: '会话', d: '新建会话（清空上下文）' },
  { k: '/rename', g: '会话', d: '给当前会话改名', arg: '名字' },
  { k: '/export', g: '会话', d: '导出当前会话（格式见设置）' },
  { k: '/model', g: '模型', d: '切换模型 / 思考档位' },
  { k: '/search', g: '导航', d: '跳到左栏搜索框' },
  { k: '/settings', g: '视图', d: '打开设置（主题 / 输入 / 模型）' }
];

t('[rank] 空查询返回全部', Pal.rankCommands(CMDS, '/', []).length, 6);
t('[rank] 没匹配到返回空数组', Pal.rankCommands(CMDS, '/zzz', []).length, 0);
// ★ 这一条是核心：/rn 必须命中 /rename，且排第一
t('[rank] /rn → /rename 排第一', at(Pal.rankCommands(CMDS, '/rn', []), 0).key, '/rename');
t('[rank] /ex → /export 排第一', at(Pal.rankCommands(CMDS, '/ex', []), 0).key, '/export');
t('[rank] /se → /search 排第一', at(Pal.rankCommands(CMDS, '/se', []), 0).key, '/search');
t('[rank] /s 能同时给出多条', Pal.rankCommands(CMDS, '/s', []).length >= 2, true);
// 命令名命中权重高于描述命中：/model 的命令名命中要压过描述里提到"模型"的 /settings
t('[rank] 命令名命中优先于描述命中', at(Pal.rankCommands(CMDS, '/model', []), 0).key, '/model');

/* ---------- 5. 高亮下标：要算上开头的斜杠 ---------- */
// '/rename' 里 r 在下标 1、n 在下标 3（名字里的 marks 是 [0,2]，+1 偏移）
const r1 = at(Pal.rankCommands(CMDS, '/rn', []), 0);
t('[rank] /rename 的高亮下标含斜杠偏移', JSON.stringify(r1.marks), '[1,3]');

/* ---------- 6. 参数提示 ---------- */
const r2 = Pal.rankCommands(CMDS, '/rename', [])[0];
t('[rank] 支持参数的命令有 argTip', typeof at(Pal.rankCommands(CMDS, '/rename', []), 0).argTip, 'string');
t('[rank] argTip 里写明了写法', at(Pal.rankCommands(CMDS, '/rename', []), 0).argTip.indexOf('/rename 名字') >= 0, true);
t('[rank] 不支持参数的命令没有 argTip', at(Pal.rankCommands(CMDS, '/new', []), 0).argTip, '');

/* ---------- 7. 带参数执行：只剩一条，且带上参数 ---------- */
const one = Pal.rankCommands(CMDS, '/rename 我的会话', []);
t('[rank] 带参数时只剩一条', one.length, 1);
t('[rank] 带参数时 arg 原样带回', at(one, 0).arg, '我的会话');
t('[rank] 带参数时 label 是完整写法', at(one, 0).label, '/rename 我的会话');
t('[rank] 带参数时分组是"执行"', at(one, 0).group, '执行');

/* ---------- 8. 最近使用：只在空查询时插队 ---------- */
const withRecent = Pal.rankCommands(CMDS, '/', ['/model', '/new']);
t('[rank] 最近使用排最前', at(withRecent, 0).key, '/model');
t('[rank] 最近使用的分组被改写', at(withRecent, 0).group, '最近使用');
t('[rank] 最近使用不重复出现', withRecent.filter((x) => x.key === '/model').length, 1);
t('[rank] 总数不变（只是重排）', withRecent.length, 6);
// ★ 一有输入就不能再插队，否则"最近用过的"会一直压住真正的匹配结果
const withQ = Pal.rankCommands(CMDS, '/rn', ['/model', '/new']);
t('[rank] 有输入时最近使用不插队', at(withQ, 0).key, '/rename');
t('[rank] 有输入时"最近使用"分组消失', withQ.filter((x) => x.group === '最近使用').length, 0);

/* ---------- 9. groupOf：分组变化处插标题 ---------- */
const grouped = Pal.groupOf([
  { key: '/model', group: '最近使用' },
  { key: '/new', group: '会话' },
  { key: '/rename', group: '会话' },
  { key: '/settings', group: '视图' }
]);
t('[group] 条数 = 4 项 + 3 个标题', grouped.length, 7);
t('[group] 第一项是标题', at(grouped, 0).header, '最近使用');
t('[group] 同组不重复插标题', grouped.filter((x) => x.header === '会话').length, 1);

/* ---------- 10. 边界：空输入不炸 ---------- */
t('[edge] rankCommands 空命令表', Pal.rankCommands([], '/a', []).length, 0);
t('[edge] rankCommands 非数组不炸', Pal.rankCommands(null, '/a', []).length, 0);
t('[edge] fuzzy 空文本', Pal.fuzzy('', 'a'), null);

/* ---------- 11. ★ 反向验证：劣化实现必须变红 ----------
   把"子序列"改成"字符集合"（只要字符都出现过就算命中，不管顺序），
   再跑一遍关键断言 —— 必须与真实实现给出不同答案。 */
function fuzzyDegraded(text, q) {
  const tl = String(text).toLowerCase();
  const ql = String(q || '').toLowerCase();
  if (!ql) return { marks: [], score: 0 };
  for (const c of ql) if (tl.indexOf(c) < 0) return null;
  return { marks: [], score: 1 };
}
t('[反向验证] 劣化实现会认为 /nr 也命中 rename',
  !!fuzzyDegraded('rename', 'nr'), true);
t('[反向验证] 真实现不认 /nr（否则上面那条断言是空转）',
  Pal.fuzzy('rename', 'nr'), null);
t('[反向验证] 劣化实现不给高亮',
  fuzzyDegraded('rename', 'rn').marks.length, 0);
t('[反向验证] 真实现给高亮',
  Pal.fuzzy('rename', 'rn').marks.length, 2);

console.log('\n' + (fail ? '❌' : '✅') + ' pal.test.js  PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
