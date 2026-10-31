// A small PDF writer for conversations. Text only, set in the built-in Helvetica and Courier fonts,
// so there is nothing to download or embed. Characters outside Latin-1 and common punctuation print as "?".
import { SOURCE_LABEL, isoDateTime } from './util.js';
import { roleLabel } from './export.js';

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 56;

// Helvetica advance widths for ASCII 32..126, in 1/1000 em (Adobe core font metrics).
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const WINANSI = new Map([[0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2013, 0x96], [0x2014, 0x97], [0x2026, 0x85], [0x2022, 0x95], [0x20ac, 0x80], [0x2122, 0x99], [0x2192, 0x3e]]);

/** One string to WinAnsi bytes (as a JS string of char codes 0..255). */
function winAnsi(s) {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (cp === 9) out += '    ';
    else if (cp >= 32 && cp <= 126) out += ch;
    else if (cp >= 160 && cp <= 255) out += ch;
    else if (WINANSI.has(cp)) out += String.fromCharCode(WINANSI.get(cp));
    else if (cp === 0x200b || cp === 0xfe0f || cp === 0x200d) out += '';
    else out += '?';
  }
  return out;
}

function width(s, size, bold) {
  const table = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 32 && c <= 126 ? table[c - 32] : 556;
  }
  return (w * size) / 1000;
}

function esc(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 40 || c === 41 || c === 92) out += `\\${s[i]}`;
    else if (c > 126 || c < 32) out += `\\${c.toString(8).padStart(3, '0')}`;
    else out += s[i];
  }
  return out;
}

/** Wraps proportional text to a width. Words longer than a line are broken. */
function wrapProportional(line, size, bold, maxW) {
  const out = [];
  let cur = '';
  for (const word of line.split(/(?<= )/)) {
    if (width(cur + word, size, bold) <= maxW) { cur += word; continue; }
    if (cur) { out.push(cur.trimEnd()); cur = ''; }
    let w = word;
    while (width(w, size, bold) > maxW) {
      let n = w.length;
      while (n > 1 && width(w.slice(0, n), size, bold) > maxW) n--;
      out.push(w.slice(0, n)); w = w.slice(n);
    }
    cur = w;
  }
  out.push(cur.trimEnd());
  return out;
}

class Doc {
  constructor() { this.pages = []; this.cur = null; this.y = 0; this.newPage(); }
  newPage() { this.cur = []; this.pages.push(this.cur); this.y = PAGE_H - MARGIN; }
  need(h) { if (this.y - h < MARGIN) this.newPage(); }
  text(str, { font = 'F1', size = 10, lead = size * 1.4, x = MARGIN, gray = 0.1, bg = null, bgW = 0 } = {}) {
    this.need(lead);
    if (bg != null) this.cur.push(`${bg} g ${x - 4} ${(this.y - lead + size * 0.3).toFixed(2)} ${bgW} ${lead.toFixed(2)} re f`);
    this.cur.push(`BT ${gray} g /${font} ${size} Tf ${x.toFixed(2)} ${(this.y - size).toFixed(2)} Td (${esc(str)}) Tj ET`);
    this.y -= lead;
  }
  gap(h) { this.y -= h; if (this.y < MARGIN) this.newPage(); }
}

/** @returns {Uint8Array} */
export function conversationToPdf(conv) {
  const doc = new Doc();
  const bodyW = PAGE_W - MARGIN * 2;
  const para = (text, size, bold, extra = {}) => {
    for (const raw of winAnsi(text).split('\n')) {
      for (const l of wrapProportional(raw, size, bold, bodyW)) doc.text(l, { font: bold ? 'F2' : 'F1', size, ...extra });
    }
  };
  para(conv.title.replace(/\s+/g, ' '), 17, true, { lead: 22, gray: 0 });
  const meta = [SOURCE_LABEL[conv.source] || conv.source, conv.created != null ? isoDateTime(conv.created) : '', conv.model || '', `${conv.messages.length} messages`].filter(Boolean).join('  |  ');
  para(meta, 9, false, { gray: 0.4, lead: 14 });
  doc.gap(8);

  const codeSize = 8.5, codeLead = 11.5, codeCols = Math.floor((bodyW - 8) / (codeSize * 0.6));
  for (const m of conv.messages) {
    doc.gap(8);
    doc.need(60);
    para(`${roleLabel(conv, m.role)}${m.time != null ? `   ${isoDateTime(m.time)}` : ''}`, 10, true, { gray: m.role === 'user' ? 0.15 : 0.35, lead: 15 });
    const lines = m.text.split('\n');
    let inCode = false;
    for (const line of lines) {
      if (/^(`{3,}|~{3,})/.test(line)) { inCode = !inCode; continue; }
      if (!inCode) { para(line, 10, false, { lead: 13.5 }); continue; }
      const a = winAnsi(line);
      for (let i = 0; i === 0 || i < a.length; i += codeCols) {
        doc.text(a.slice(i, i + codeCols), { font: 'F3', size: codeSize, lead: codeLead, x: MARGIN + 4, bg: 0.955, bgW: bodyW });
      }
    }
    for (const a of m.atts) para(`Attachment: ${a.name}`, 9, false, { gray: 0.4, lead: 13 });
  }

  // Assemble: 1 catalog, 2 pages, 3-5 fonts, 6 info, then (content, page) per page.
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages, filled below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  add(`<< /Title (${esc(winAnsi(conv.title).slice(0, 200))}) /Producer (ThreadKeep Export) >>`);
  const kids = [];
  for (const ops of doc.pages) {
    const stream = ops.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const page = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${content} 0 R >>`);
    kids.push(`${page} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
