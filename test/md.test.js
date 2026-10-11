// ============================================================
// test/md.test.js —— Markdown 渲染器的行为断言
// 跑法：node test/md.test.js
// 为什么要有这个：渲染器是纯逻辑，肉眼看截图判断不了
// 「代码块里有没有被误做行内解析」这种事，只有断言说得清。
// ============================================================
'use strict';

const MD = require('../md.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}
function inc(name, hay, needle, shouldHave) {
  const has = String(hay).indexOf(needle) >= 0;
  t(name + (shouldHave ? '（应包含 ' + needle + '）' : '（不应包含 ' + needle + '）'), has, shouldHave);
}

/* ---------- 行内 ---------- */
t('粗体', MD.inline('a **b** c'), 'a <strong>b</strong> c');
t('斜体', MD.inline('a *b* c'), 'a <em>b</em> c');
t('粗斜体', MD.inline('***x***'), '<strong><em>x</em></strong>');
t('行内代码', MD.inline('a `x` b'), 'a <code>x</code> b');
t('删除线', MD.inline('~~x~~'), '<del>x</del>');
t('下划线不当斜体', MD.inline('snake_case_name'), 'snake_case_name');
t('http 链接放行', MD.inline('[t](https://a.com)'), '<a href="https://a.com" target="_blank" rel="noreferrer">t</a>');
t('javascript: 链接被拦', MD.inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');

/* ---------- 块级 ---------- */
t('段落', MD.toHtml('hello'), '<p>hello</p>');
t('H1', MD.toHtml('# T'), '<h1>T</h1>');
t('H3', MD.toHtml('### T'), '<h3>T</h3>');
t('H6', MD.toHtml('###### T'), '<h6>T</h6>');
t('7 个 # 不是有效标题（按段落处理）', MD.toHtml('####### T'), '<p>####### T</p>');
t('无序列表', MD.toHtml('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
t('有序列表', MD.toHtml('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
t('星号列表', MD.toHtml('* a'), '<ul><li>a</li></ul>');
t('分割线', MD.toHtml('---'), '<hr>');
t('引用', MD.toHtml('> hi'), '<blockquote><p>hi</p></blockquote>');
t('列表被段落正确切断', MD.toHtml('- a\n\nb'), '<ul><li>a</li></ul><p>b</p>');

/* ---------- 代码块：内部绝不做行内解析 ---------- */
const code = MD.toHtml('```\n**not bold** <b>x</b> `tick`\n```');
inc('代码块结构', code, '<pre><code>', true);
inc('代码块内不解析粗体', code, '<strong>', false);
inc('代码块内反引号不转行内码', code, '<code>tick</code>', false);
inc('代码块保留字面反引号', code, '`tick`', true);
inc('代码块保留字面星号', code, '**not bold**', true);
inc('代码块内 HTML 被转义', code, '&lt;b&gt;', true);
inc('代码块带语言标签', MD.toHtml('```js\nx\n```'), '<span class="md-lang">js</span>', true);
// 没写语言时别显示英文 'text' —— 界面文案一律中文
t('无语言时标签显示"纯文本"', MD.toHtml('```\nx\n```').indexOf('<span class="md-lang">纯文本</span>') >= 0, true);
inc('代码块带复制按钮', MD.toHtml('```\nx\n```'), 'class="md-copy"', true);
// 界面文案一律中文：这个按钮是从这里生成的，改中文时最容易漏（漏了就当没改）
t('复制按钮文案是中文', /<button class="md-copy"[^>]*>复制<\/button>/.test(MD.toHtml('```\nx\n```')), true);
t('复制按钮不再出现 COPY', MD.toHtml('```\nx\n```').indexOf('>COPY<') < 0, true);
t('未闭合代码块也能收尾', MD.toHtml('```\nabc').indexOf('<pre><code>abc</code></pre>') >= 0, true);

/* ---------- 表格 ---------- */
const tb = MD.toHtml('| A | B |\n| --- | ---: |\n| 1 | 2 |');
inc('表格表头', tb, '<th style="text-align:left">A</th>', true);
inc('表格右对齐', tb, '<th style="text-align:right">B</th>', true);
inc('表格数据行', tb, '<td style="text-align:left">1</td>', true);
inc('表格闭合', tb, '</tbody></table>', true);
t('表格里的竖线不算表格（无分隔行）', MD.toHtml('a | b'), '<p>a | b</p>');

/* ---------- 安全：XSS ---------- */
inc('script 标签被转义', MD.toHtml('<script>alert(1)</script>'), '&lt;script&gt;', true);
inc('img onerror 被转义', MD.toHtml('<img src=x onerror=alert(1)>'), '&lt;img', true);
inc('段落里不产生真标签', MD.toHtml('<b>bold</b>'), '<b>', false);

/* ---------- 嵌套列表 ---------- */
const nl = MD.toHtml('- a\n  - b\n- c');
inc('嵌套列表有内层 ul', nl, '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', true);

/* ---------- 混合文档：不崩、结构齐 ---------- */
const mixed = MD.toHtml([
  '## 标题', '', '- 项一', '- 项二', '',
  '```js', 'const a = 1;', '```', '',
  '| K | V |', '| --- | --- |', '| a | 1 |', '',
  '> 引用 **粗**', '', '结尾段落'
].join('\n'));
inc('混合: 标题', mixed, '<h2>标题</h2>', true);
inc('混合: 列表', mixed, '<li>项一</li>', true);
inc('混合: 代码', mixed, 'const a = 1;', true);
inc('混合: 表格', mixed, '<table>', true);
inc('混合: 引用内粗体', mixed, '<blockquote><p>引用 <strong>粗</strong></p></blockquote>', true);
inc('混合: 收尾段落', mixed, '<p>结尾段落</p>', true);

/* ---------- 汇总 ---------- */
console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
