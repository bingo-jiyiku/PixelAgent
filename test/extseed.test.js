// ============================================================
// test/extseed.test.js —— 扩展播种决策的行为断言
// 跑法：node test/extseed.test.js   （纯逻辑，不开 Electron）
//
// 对应老板 2026-10-12：「把拓展插件都打包上传进去，让新用户下载安装就可以
// 直接用」。这里验的是"播种"的三个决策点：还差谁、怎么合进 settings、
// 用户的其它设置会不会被碰。
// 反向验证：把合并改成覆盖式（丢掉原有 packages）→「原有设置一根头发都不碰」红；
//            去掉去重 → 「同一个包不会进两次」红。
// ============================================================
'use strict';

const { pendingPackages, mergeExtPackages } = require('../ext-seed.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  console.log('   got : ' + JSON.stringify(got));
  console.log('   want: ' + JSON.stringify(want));
}

const SIX = ['npm:pi-background-tasks', 'npm:pi-subagents', 'npm:pi-hermes-memory',
  'npm:pi-web-access', 'npm:pi-lens', 'npm:pi-simplify'];

/* ---- 1. 还差哪些没播种 ---- */
t('全新机器：六个全都欠', pendingPackages(SIX, []), SIX);
t('没读过标记文件（null）：按全新算', pendingPackages(SIX, null), SIX);
t('标记不是数组：按全新算', pendingPackages(SIX, '坏了'), SIX);
t('播种过一半：只欠后半', pendingPackages(SIX, SIX.slice(0, 2)), SIX.slice(2));
t('全部播种过：一个都不欠', pendingPackages(SIX, SIX.slice()), []);
t('标记里多出陌生条目不影响（加性语义，只减不加）',
  pendingPackages(SIX, SIX.concat(['npm:别人家的'])), []);

/* ---- 2. 合并进 settings ---- */
t('没有 packages 键的 settings：补上六个', mergeExtPackages({ defaultModel: 'x' }, SIX).packages, SIX);
t('packages 不是数组（坏配置）：当空处理', mergeExtPackages({ packages: '坏' }, SIX).packages, SIX);
t('settings 整个是 null：从零建', mergeExtPackages(null, SIX).packages, SIX);
t('settings 不是对象（字符串）：从零建', mergeExtPackages('坏', SIX).packages, SIX);

/* ---- 3. 只动 packages，别的键一根头发都不碰（反向验证点） ---- */
const rich = { defaultModel: 'ark-code-latest', defaultProvider: 'agent-plan', theme: 'dark', packages: ['npm:pi-lens'] };
const out = mergeExtPackages(rich, SIX);
t('原有键原样保留', [out.defaultModel, out.defaultProvider, out.theme],
  ['ark-code-latest', 'agent-plan', 'dark']);
t('原有的包排在前面、新补的追加（顺序 = pi 的加载顺序）',
  out.packages, ['npm:pi-lens'].concat(SIX.filter((p) => p !== 'npm:pi-lens')));
t('合并不改原对象（纯函数）', rich.packages, ['npm:pi-lens']);

/* ---- 4. 同一个包不会进两次（反向验证点：去掉去重会红） ---- */
t('已存在的不重复追加', mergeExtPackages({ packages: SIX.slice() }, SIX).packages, SIX);
t('want 自己带重复也去重', mergeExtPackages({}, ['npm:pi-lens', 'npm:pi-lens']).packages, ['npm:pi-lens']);
t('want 里的垃圾条目（非字符串）被滤掉', mergeExtPackages({}, [null, '', 42, 'npm:ok']).packages, ['npm:ok']);

if (fail) { console.log('\n❌ extseed FAIL ' + fail + ' / PASS ' + pass); process.exit(1); }
console.log('✅ extseed 全过（' + pass + ' 条）');
