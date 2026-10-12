/* ============================================================
   ext-seed.js —— 捆绑扩展的"播种"决策（纯逻辑，零依赖）
   为什么抽出来：main.js 里别的东西都绑着 Electron/fs，
   这块只做集合运算和 JSON 合并，node 下能直接喂断言。
   用法：node   require('./ext-seed.js')
        main   const { pendingPackages, mergeExtPackages } = require('./ext-seed.js');

   背景（老板 2026-10-12：「把拓展插件都打包上传进去，让新用户下载安装
   就可以直接用」）：pi 的 npm 扩展平时装在 ~/.pi/agent/npm 下，由
   settings.json 的 packages 数组登记。新用户/公司机器的 ~/.pixelagent/agent
   是空的 ⇒ 一个扩展都没有 ⇒ "很笨，不会上网"（pi-web-access 没装上）。
   打包版把这些扩展塞进 extraResources，首次运行"播种"到 agent 目录。
   ============================================================ */
'use strict';

/**
 * 还差哪些包没播种：manifest 里有、已播种清单里没有的。
 * 已播种清单来自 USER_DIR/.ext-seeded.json（它记录"确保过在盘上"的包）。
 * 返回原样条目（"npm:pi-web-access" 这种），顺序同 manifest。
 */
function pendingPackages(manifestPackages, seededPackages) {
  const want = Array.isArray(manifestPackages) ? manifestPackages : [];
  const done = new Set(Array.isArray(seededPackages) ? seededPackages : []);
  return want.filter((p) => typeof p === 'string' && p && !done.has(p));
}

/**
 * 把要启用的扩展**加性**合并进 pi 的 settings.json。
 * 三条硬规则：
 * ① 只动 packages 一个键 —— defaultModel/theme 等用户设置一根头发都不碰；
 * ② 去重且保序（原有的在前，新补的追加）—— pi 按这个顺序加载；
 * ③ settings 坏掉/不是对象时从 { packages: [...] } 重新开始，不抛。
 */
function mergeExtPackages(settings, wantPackages) {
  const want = (Array.isArray(wantPackages) ? wantPackages : [])
    .filter((p) => typeof p === 'string' && p);
  const base = (settings && typeof settings === 'object' && !Array.isArray(settings)) ? settings : {};
  const have = Array.isArray(base.packages) ? base.packages.filter((p) => typeof p === 'string' && p) : [];
  const seen = new Set(have);
  const merged = have.slice();
  for (const p of want) { if (!seen.has(p)) { seen.add(p); merged.push(p); } }
  return Object.assign({}, base, { packages: merged });
}

module.exports = { pendingPackages, mergeExtPackages };
