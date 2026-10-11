/* ============================================================
   md.js —— 轻量 Markdown 渲染（纯逻辑，零依赖）
   为什么单独一个文件：renderer 里其它东西都绑着 DOM，
   只有这块是纯函数。抽出来 node 就能直接喂数据跑断言，
   不用开 Electron 看截图猜。
   用法：浏览器 <script src="md.js"> → window.PixelMD
         node  require('./md.js')
   ============================================================ */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PixelMD = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 只放行 http(s)，挡住 javascript: 之类的注入
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return t;
  }

  function splitRow(l) {
    return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }
  function isSep(l) {
    return /\|/.test(l) && /^[\s|:\-]+$/.test(l) && /-/.test(l);
  }
  function table(sep, head, rows) {
    const aligns = splitRow(sep).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : (r ? 'right' : 'left');
    });
    const cell = (tag, text, i) =>
      '<' + tag + ' style="text-align:' + (aligns[i] || 'left') + '">' +
      inline(text == null ? '' : text) + '</' + tag + '>';
    let h = '<table><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead><tbody>';
    h += rows.map((r) => '<tr>' + head.map((_, i) => cell('td', r[i], i)).join('') + '</tr>').join('');
    return h + '</tbody></table>';
  }

  function toHtml(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const stack = [];          // 列表层级 [{type}]
    let para = [];
    let i = 0;

    const flushPara = () => {
      if (!para.length) return;
      out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      para = [];
    };
    const closeLists = (to) => {
      while (stack.length > to) {
        const top = stack.pop();
        if (top.liOpen) out.push('</li>');   // 延迟闭合的 li 在这里补上
        out.push('</' + top.type + '>');
      }
    };

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');

      if (!line.trim()) { flushPara(); closeLists(0); i++; continue; }

      // 代码块 ```：内部只转义，绝不做行内解析
      const fence = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushPara(); closeLists(0);
        const lang = fence[1] || 'text';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<div class="md-code"><div class="md-code-hd">' +
          '<span class="md-lang">' + esc(lang) + '</span>' +
          '<button class="md-copy" type="button">COPY</button></div>' +
          '<pre><code>' + esc(buf.join('\n')) + '</code></pre></div>');
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeLists(0); out.push('<hr>'); i++; continue; }

      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); closeLists(0);
        const lv = h[1].length;
        out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
        i++; continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushPara(); closeLists(0);
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + toHtml(buf.join('\n')) + '</blockquote>');
        continue;
      }

      if (/\|/.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        flushPara(); closeLists(0);
        const head = splitRow(line);
        const sep = lines[i + 1];
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push(table(sep, head, rows));
        continue;
      }

      const ul = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
      const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
      if (ul || ol) {
        flushPara();
        const depth = ((ul ? ul[1] : ol[1]).length >= 2) ? 1 : 0;
        const type = ul ? 'ul' : 'ol';
        const text = ul ? ul[2] : ol[3];

        // 收掉比目标更深的层（每层先关 li 再关列表）
        while (stack.length > depth + 1) {
          const top = stack.pop();
          if (top.liOpen) out.push('</li>');
          out.push('</' + top.type + '>');
        }
        if (stack.length < depth + 1) {
          // 进入更深一层：父级 li 故意不关，让子列表落在它内部
          out.push('<' + type + '>');
          stack.push({ type, liOpen: false });
        } else {
          const top = stack[stack.length - 1];
          if (top.type !== type) {              // 同层换类型
            if (top.liOpen) out.push('</li>');
            out.push('</' + top.type + '>');
            stack.pop();
            out.push('<' + type + '>');
            stack.push({ type, liOpen: false });
          }
        }

        const top = stack[stack.length - 1];
        if (top.liOpen) out.push('</li>');       // 同层上一项收尾
        out.push('<li>' + inline(text));         // 先不闭合：可能后面还要挂子列表
        top.liOpen = true;
        i++; continue;
      }

      flushPara();
      para.push(line);
      i++;
    }
    flushPara();
    closeLists(0);
    return out.join('');
  }

  return { toHtml: toHtml, inline: inline, esc: esc };
});
