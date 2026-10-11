/* ============================================================
   parse.js —— 从 pi 事件里解析结构化数据（纯逻辑，零依赖）
   为什么抽出来：renderer 里别的东西都绑着 DOM，只有这块是纯函数。
   抽出来 node 就能直接喂**真实抓下来的事件**跑断言，
   不用开 Electron 靠截图猜。
   用法：浏览器 <script src="parse.js"> → window.PixelParse
         node  require('./parse.js')
   ============================================================ */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PixelParse = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 工具结果的文本内容。真实结构是 { content: [{type:'text', text}] }
  function extractText(res) {
    if (!res) return '';
    if (typeof res === 'string') return res;
    if (Array.isArray(res.content)) {
      return res.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
    }
    if (typeof res.output === 'string') return res.output;
    if (typeof res.text === 'string') return res.text;
    return '';
  }

  function normTodo(t) {
    if (!t || typeof t !== 'object') return null;
    return { id: t.id, done: !!t.done, text: String(t.text == null ? '' : t.text) };
  }

  /**
   * 从一次 tool_execution_end 事件里解析出待办列表。
   *
   * 三条路都留着，因为「details 到底放在哪个位置」这件事光看文档靠不住：
   *   1) 事件顶层 ev.details
   *   2) ev.result.details  ← **实测就是这个位置**（喂真事件抓包得到的结构）
   *   3) 结果文本里的机器标记 PIXELTODOS:{...}（我们自己的 todo 扩展额外写的）
   *   4) 结果文本里人类可读的 "[x] #1: 内容"
   *
   * 返回 { known, list }：known 为 false 表示"这次结果里压根没有待办信息"，
   * 调用方应当**保留现有列表不动**，而不是把已经显示的清空。
   * 这个区分是必要的：`clear` 动作会返回合法的空列表（known=true），
   * 而"解析不出来"是另一回事（known=false）。两者混在一起，
   * 任何一次解析失败都会把界面上的待办抹掉。
   */
  /**
   * 从文本里抠出 PIXELTODOS: 后面那个 JSON 对象。
   * 为什么不用正则：内容是嵌套的（{"todos":[{"id":1}]}），
   * 非贪婪正则在第一个 } 就断，贪婪正则又可能吃过头。
   * 直接按花括号配平扫描最稳 —— 而且要跳过字符串字面量里的括号，
   * 否则一条 text 里带 "{" 的待办就能把扫描带偏。
   */
  function extractMarked(txt) {
    if (!txt) return null;
    const at = txt.indexOf('PIXELTODOS:');
    if (at < 0) return null;
    const start = txt.indexOf('{', at);
    if (start < 0) return null;

    let depth = 0, inStr = false, escaped = false;
    for (let i = start; i < txt.length; i++) {
      const c = txt[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return txt.slice(start, i + 1);
      }
    }
    return null;
  }

  function todosFromToolResult(ev) {
    if (!ev) return { known: false, list: [] };

    const d = ev.details || (ev.result && ev.result.details);
    if (d && Array.isArray(d.todos)) {
      return { known: true, list: d.todos.map(normTodo).filter(Boolean) };
    }

    const txt = extractText(ev.result);

    const marked = extractMarked(txt);
    if (marked) {
      try {
        const j = JSON.parse(marked);
        if (j && Array.isArray(j.todos)) {
          return { known: true, list: j.todos.map(normTodo).filter(Boolean) };
        }
      } catch (e) { /* 标记行坏了就往下走 */ }
    }

    if (/^\s*No todos\s*$/m.test(txt)) return { known: true, list: [] };

    const out = [];
    const re = /^\s*\[([ xX])\]\s*#(\d+):\s*(.*)$/gm;
    let mm;
    while ((mm = re.exec(txt))) {
      out.push({ id: Number(mm[2]), done: mm[1].toLowerCase() === 'x', text: mm[3] });
    }
    return { known: out.length > 0, list: out };
  }

  /* ============================================================
     图片"到底有没有进请求"的判定
     ------------------------------------------------------------
     为什么必须有这块纯逻辑：pi 处理不了图时**不报错**，
     它把 image 块删掉，只在文本里留一句方括号标记。
     上一轮我为这件事查了两轮，就是因为只数了 image 块、没读文本。
     把判定抽成纯函数，就能拿**真实抓下来的事件**跑断言。
     ============================================================ */

  // pi 的两种丢图标记。措辞来自真实事件流（test/_repro.log / _img.log），
  // 不是猜的 —— 改成猜的措辞，这个函数就再也抓不到东西了。
  const IMG_OMIT_MARKS = [
    {
      key: 'resize',
      re: /\[Image omitted[^\]]*\]/i
    },
    {
      key: 'nomodel',
      re: /\[Current model does not support images[^\]]*\]/i
    }
  ];

  /**
   * 看一条 user 消息的 content，回答两个问题：
   *   imgs —— 里面真的有几个 image 内容块（图进得去就 >0）
   *   omit —— 有没有 pi 留下的丢图标记（有就说明图被删了），带是哪一种
   *
   * 两种内容形态都吃：字符串、以及 [{type:'text'|'image'}]。
   */
  function inspectUserContent(content) {
    let imgs = 0;
    const texts = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c) continue;
        if (c.type === 'image') imgs++;
        else if (c.type === 'text') texts.push(String(c.text || ''));
      }
    }

    let omit = null;
    for (const t of texts) {
      for (const m of IMG_OMIT_MARKS) {
        if (m.re.test(t)) { omit = { key: m.key, text: (t.match(m.re) || [''])[0] }; break; }
      }
      if (omit) break;
    }

    return { imgs: imgs, omit: omit, text: texts.join('\n') };
  }

  return { extractText, normTodo, todosFromToolResult, extractMarked, inspectUserContent, IMG_OMIT_MARKS };
});
