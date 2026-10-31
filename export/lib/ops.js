// Operations the worker runs on loaded conversations. Pure functions over normalized data plus JSZip,
// so Node tests can call them directly.
import { buildClaudePackage } from './claude.js';
import { FORMATS, chatFileName, toMarkdown } from './export.js';
import { conversationToPdf } from './pdf.js';
import { SOURCE_LABEL, parseQuery, uniqueNamer } from './util.js';

export const PRO_REQUIRED = 'pro_required';

export function singleExport(conv, format) {
  const f = FORMATS[format];
  if (!f || format === 'json') throw new Error('Unknown format.');
  return { filename: chatFileName(conv, f.ext), mime: f.mime, text: f.render(conv, {}) };
}

function folderFor(convs, conv) {
  const sources = new Set(convs.map((c) => c.source));
  return sources.size > 1 ? `${SOURCE_LABEL[conv.source].toLowerCase()}/` : '';
}

/**
 * Zip of many chats. format: 'md' | 'pdf' | 'json'.
 * `pro` must be true: this is the paid feature, and the worker refuses without it.
 */
export async function bulkZip(JSZip, convs, { format, pro, frontmatter = false, onProgress = () => {} }) {
  if (!pro) throw Object.assign(new Error('Bulk export needs a ThreadKeep Pro license.'), { code: PRO_REQUIRED });
  if (!['md', 'pdf', 'json'].includes(format)) throw new Error('Unknown format.');
  const zip = new JSZip();
  const name = uniqueNamer();
  const index = [];
  let i = 0;
  for (const c of convs) {
    const path = `${folderFor(convs, c)}${name(chatFileName(c, format))}`;
    if (format === 'pdf') zip.file(path, conversationToPdf(c));
    else if (format === 'json') zip.file(path, FORMATS.json.render(c));
    else zip.file(path, toMarkdown(c, { frontmatter }));
    index.push({ id: c.id, source: c.source, title: c.title, created: c.created, updated: c.updated, messages: c.messages.length, file: path });
    onProgress(++i, convs.length);
    if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0)); // let the worker answer messages
  }
  if (format === 'json') zip.file('index.json', JSON.stringify(index, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function claudeZip(JSZip, convs, { pro, ...options }) {
  if (!pro) throw Object.assign(new Error('The Claude helper needs a ThreadKeep Pro license.'), { code: PRO_REQUIRED });
  const { files, report } = buildClaudePackage(convs, options);
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.text);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, report };
}

/** Case-insensitive AND search. Quoted phrases stay together. Returns hits per conversation and a snippet. */
export function searchConversations(convs, q) {
  const terms = parseQuery(q);
  if (!terms.length) return [];
  const results = [];
  for (const c of convs) {
    const title = c.title.toLowerCase();
    let hits = 0;
    let snippet = '';
    const found = new Set();
    for (const t of terms) if (title.includes(t)) found.add(t);
    for (const m of c.messages) {
      const lower = m.text.toLowerCase();
      for (const t of terms) {
        const at = lower.indexOf(t);
        if (at === -1) continue;
        found.add(t);
        hits++;
        if (!snippet) {
          const from = Math.max(0, at - 50);
          snippet = `${from > 0 ? '…' : ''}${m.text.slice(from, at + t.length + 90).replace(/\s+/g, ' ')}`;
        }
      }
    }
    if (found.size === terms.length) results.push({ id: c.id, hits: hits + (terms.some((t) => title.includes(t)) ? 3 : 0), snippet });
  }
  results.sort((a, b) => b.hits - a.hits);
  return results;
}
