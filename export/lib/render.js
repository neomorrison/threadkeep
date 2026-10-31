// Draws chat text into the page. Builds DOM nodes with textContent only, never innerHTML,
// so nothing in an export can inject markup or script. Supports fenced code, headings, lists,
// inline code, bold, and highlighting of search terms.

function highlight(parent, text, terms) {
  if (!terms.length) { parent.append(text); return; }
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  text.split(re).forEach((part, i) => {
    if (i % 2) { const m = document.createElement('mark'); m.textContent = part; parent.append(m); } else if (part) parent.append(part);
  });
}

function inline(parent, text, terms) {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  text.split(re).forEach((part) => {
    if (!part) return;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) { const c = document.createElement('code'); highlight(c, part.slice(1, -1), terms); parent.append(c); }
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) { const b = document.createElement('strong'); highlight(b, part.slice(2, -2), terms); parent.append(b); }
    else highlight(parent, part, terms);
  });
}

export function renderMessageText(container, text, terms = []) {
  const lines = text.split('\n');
  let i = 0;
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    para.forEach((l, n) => { if (n) p.append(document.createElement('br')); inline(p, l, terms); });
    container.append(p);
    para = [];
  };
  const flushList = () => { list = null; };
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fenceMatch) {
      flushPara(); flushList();
      const close = fenceMatch[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].startsWith(close) && lines[i].trim() === close)) body.push(lines[i++]);
      i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fenceMatch[2]) pre.dataset.lang = fenceMatch[2];
      highlight(code, body.join('\n'), terms);
      pre.append(code);
      container.append(pre);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const el = document.createElement('p'); el.className = 'h';
      inline(el, h[2], terms); container.append(el);
    } else if (li) {
      flushPara();
      if (!list) { list = document.createElement('ul'); container.append(list); }
      const item = document.createElement('li'); inline(item, li[1], terms); list.append(item);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
    i++;
  }
  flushPara();
}
