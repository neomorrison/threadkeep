// Turns one normalized conversation into Markdown, plain text or JSON.
import { SOURCE_LABEL, formatBytes, isoDate, isoDateTime, slug } from './util.js';

export function roleLabel(conv, role) {
  if (role === 'user') return 'You';
  if (role === 'tool') return 'Tool';
  return SOURCE_LABEL[conv.source] || 'Assistant';
}

function attLine(a) {
  const bits = [a.mime, a.size != null ? formatBytes(a.size) : ''].filter(Boolean).join(', ');
  return `Attachment: ${a.name}${bits ? ` (${bits})` : ''}`;
}

function metaBits(conv) {
  const bits = [`Source: ${SOURCE_LABEL[conv.source] || conv.source}`];
  if (conv.created != null) bits.push(`Created: ${isoDateTime(conv.created)}`);
  if (conv.updated != null && conv.updated !== conv.created) bits.push(`Updated: ${isoDateTime(conv.updated)}`);
  if (conv.model) bits.push(`Model: ${conv.model}`);
  bits.push(`Messages: ${conv.messages.length}`);
  return bits;
}

function yamlString(s) { return JSON.stringify(String(s)); }

/**
 * @param {object} conv
 * @param {{ frontmatter?: boolean, compact?: boolean, maxMessageChars?: number, heading?: number }} opts
 */
export function toMarkdown(conv, opts = {}) {
  const { frontmatter = false, compact = false, maxMessageChars = 0 } = opts;
  const out = [];
  if (frontmatter) {
    out.push('---');
    out.push(`title: ${yamlString(conv.title)}`);
    out.push(`source: ${conv.source}`);
    if (conv.created != null) out.push(`created: ${new Date(conv.created).toISOString()}`);
    if (conv.updated != null) out.push(`updated: ${new Date(conv.updated).toISOString()}`);
    if (conv.model) out.push(`model: ${yamlString(conv.model)}`);
    out.push(`id: ${yamlString(conv.id)}`);
    out.push(`tags: [ai-chat, ${conv.source}]`);
    out.push('---', '');
  }
  out.push(`# ${conv.title.replace(/\s+/g, ' ')}`, '', metaBits(conv).join(' · '), '');
  for (const m of conv.messages) {
    if (compact && m.role === 'tool') continue;
    out.push('---', '');
    out.push(`## ${roleLabel(conv, m.role)}${m.role === 'tool' && m.tool ? ` (${m.tool})` : ''}`, '');
    if (m.time != null) out.push(`*${isoDateTime(m.time)}*`, '');
    let text = m.text;
    if (maxMessageChars > 0 && text.length > maxMessageChars) {
      const head = Math.floor(maxMessageChars * 0.75);
      const tail = maxMessageChars - head;
      text = `${text.slice(0, head)}\n\n[... ${text.length - maxMessageChars} characters trimmed ...]\n\n${text.slice(text.length - tail)}`;
    }
    if (text) out.push(text, '');
    for (const a of m.atts) out.push(`> ${attLine(a)}`, '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function toText(conv) {
  const out = [conv.title, metaBits(conv).join(' | '), ''];
  for (const m of conv.messages) {
    out.push(`[${roleLabel(conv, m.role)}${m.time != null ? ` ${isoDateTime(m.time)}` : ''}]`);
    if (m.text) out.push(m.text.replace(/^(`{3,}|~{3,}).*\n?/gm, ''));
    for (const a of m.atts) out.push(attLine(a));
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function toJSON(conv) {
  return `${JSON.stringify({ threadkeep_export: 1, ...conv }, null, 2)}\n`;
}

/** File name for one chat: 2025-01-02-title.md */
export function chatFileName(conv, ext) {
  const d = isoDate(conv.created ?? conv.updated);
  return `${d ? `${d}-` : ''}${slug(conv.title)}.${ext}`;
}

export const FORMATS = {
  md: { ext: 'md', mime: 'text/markdown;charset=utf-8', render: (c, o) => toMarkdown(c, o) },
  txt: { ext: 'txt', mime: 'text/plain;charset=utf-8', render: (c) => toText(c) },
  json: { ext: 'json', mime: 'application/json;charset=utf-8', render: (c) => toJSON(c) },
};
