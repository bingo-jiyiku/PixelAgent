/* ============================================================
   pal.js —— 命令面板的纯逻辑（不含 DOM）
   ------------------------------------------------------------
   拆出来的理由：过滤/排序/参数解析这些规则最容易悄悄错，
   而且错了以后"看起来还能用"（比如 `/rn` 匹配到了 `/new`），
   只有**断言 + 反向验证**能发现。放在这里就能用 Node 直接跑，
   不必每次起 Electron。
   渲染和键盘留在 renderer.js（那是 DOM 的事）。

   暴露：fuzzy / segments / parseCmdInput / rankCommands / groupOf
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Pal = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 模糊匹配 ----------
     按顺序出现的字符就算命中（子序列匹配），并回传命中下标用来高亮。
     打分规则：
       · 命中位置接着上一个 → 连续，加分（2 + run）
       · 命中在词首（下标 0）→ 额外加分
     这样 `/rn` 会排到 /rename，而不是任何"r 和 n 隔很远"的命令。 */
  function fuzzy(text, q) {
    const s = String(text == null ? '' : text);
    const ql = String(q == null ? '' : q).toLowerCase();
    if (!ql) return { marks: [], score: 0 };
    const tl = s.toLowerCase();
    let ti = 0, score = 0, run = 0;
    const marks = [];
    for (let qi = 0; qi < ql.length; qi++) {
      const c = ql[qi];
      let found = -1;
      for (let i = ti; i < tl.length; i++) if (tl[i] === c) { found = i; break; }
      if (found < 0) return null;                  // 这一位找不到 → 整体不命中
      if (found === ti) { run += 1; score += 2 + run; } else { run = 0; score += 1; }
      if (found === 0) score += 3;
      marks.push(found);
      ti = found + 1;
    }
    return { marks, score };
  }

  /* ---------- 把"原文 + 命中下标"切成片段，交给渲染层去转义/上色 ----------
     为什么要切成片段而不是直接吐 HTML：转义和拼 HTML 必须在一个地方做，
     分两处做迟早会出现"先拼后转义"/"漏转义"的注入。 */
  function segments(text, marks) {
    const s = String(text == null ? '' : text);
    const set = new Set(Array.isArray(marks) ? marks : []);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const hit = set.has(i);
      const last = out[out.length - 1];
      if (last && last.hit === hit) last.t += s[i];
      else out.push({ t: s[i], hit });
    }
    return out;
  }

  /* ---------- 解析「/cmd 参数」 ----------
     面板要支持 `/rename 我的会话` 这种连着写的写法。
     只在**第一个空格**切：名字里带空格（"周报 2026"）要原样留给参数。 */
  function parseCmdInput(v) {
    const s = String(v == null ? '' : v);
    const body = s.startsWith('/') ? s.slice(1) : s;
    const sp = body.indexOf(' ');
    const head = (sp < 0 ? body : body.slice(0, sp));
    const rest = sp < 0 ? '' : body.slice(sp + 1).trim();
    return { head: head, rest: rest, key: '/' + head, hasSpace: sp >= 0 };
  }

  /* ---------- 候选排序 ----------
     cmds: [{k, g, d, arg}]
     recents: ['/new', ...]（按"最近"从新到旧）
     返回 items: [{key, label, marks, desc, group, argTip}]
     ★ 一有输入就纯按匹配度排；只有空输入时才把"最近使用"插到最前面 ——
       否则"最近用过的"会一直压在真正的匹配结果上面，越用越乱。 */
  function rankCommands(cmds, v, recents) {
    const p = parseCmdInput(v);
    const list = Array.isArray(cmds) ? cmds : [];

    // 写成完整命令 + 参数 → 只留这一条，回车带参数执行
    const exact = list.filter((c) => String(c.k).toLowerCase() === p.key.toLowerCase())[0];
    if (exact && p.rest) {
      return [{
        key: exact.k, label: exact.k + ' ' + p.rest,
        marks: range(exact.k.length),
        desc: '回车执行', group: '执行', argTip: '', arg: p.rest
      }];
    }

    const q = p.head.toLowerCase();
    const scored = [];
    for (const c of list) {
      const name = String(c.k).replace(/^\//, '');
      const m1 = fuzzy(name, q);
      const m2 = q ? fuzzy(c.d, q) : null;
      if (!m1 && !m2) continue;
      scored.push({
        c,
        // 命令名命中权重高（+12）：否则"/se"会被描述里含 se 的命令挤下去
        score: (m1 ? m1.score + 12 : 0) + (m2 ? m2.score : 0),
        marks: m1 ? m1.marks.map((i) => i + 1) : []     // +1：把开头的 '/' 也算进下标
      });
    }
    scored.sort((a, b) => b.score - a.score);

    let items = scored.map((s) => ({
      key: s.c.k, label: s.c.k, marks: s.marks, desc: s.c.d || '', group: s.c.g || '',
      argTip: s.c.arg ? ('这个命令可以带参数，写成：' + s.c.k + ' ' + s.c.arg) : ''
    }));

    if (!q && Array.isArray(recents) && recents.length) {
      const top = recents
        .map((k) => items.filter((it) => it.key === k)[0])
        .filter(Boolean)
        .map((it) => { const o = {}; for (const x in it) o[x] = it[x]; o.group = '最近使用'; return o; });
      if (top.length) {
        const used = new Set(top.map((t) => t.key));
        items = top.concat(items.filter((it) => !used.has(it.key)));
      }
    }
    return items;
  }

  function range(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; }

  /* ---------- 分组：渲染时在分组变化处插一条标题 ---------- */
  function groupOf(items) {
    const out = [];
    let last = null;
    (items || []).forEach((it) => {
      if (it.group && it.group !== last) { last = it.group; out.push({ header: it.group }); }
      out.push(it);
    });
    return out;
  }

  return { fuzzy, segments, parseCmdInput, rankCommands, groupOf };
});
