// Format detection and normalization for AI chat exports.
//
// Every parser returns conversations in one shape:
//   { id, source, title, created, updated, model, extra, messages: [ { role, text, time, atts } ] }
// role: 'user' | 'assistant' | 'tool'. time: ms since epoch or null. atts: [ { name, mime, size } ].
//
// Schema sources (see tests/export/fixtures/README.md for the details and what is unverified):
//  - ChatGPT: the conversations.json that "Settings > Data controls > Export data" produces. Each conversation
//    has `mapping` (node id -> { id, message, parent, children }) and `current_node`.
//  - Claude: Anthropic's data export. conversations.json is an array of { uuid, name, created_at, updated_at,
//    chat_messages: [ { uuid, sender: 'human'|'assistant', text, content: [blocks], attachments, files, created_at } ] }.
//  - Gemini: Google Takeout > My Activity > Gemini Apps (MyActivity.json or MyActivity.html). It is an activity
//    log, not a chat tree, so prompt/response pairs are grouped into sessions by time gap.
//  - Grok: the grok.com data export. Best-effort reader for { conversations: [ { conversation, responses: [ { response } ] } ] }.
import { fence, toMs } from './util.js';

/* ------------------------------------------------------------------ detection */

/** Looks at one parsed JSON value (the first array element, or a whole top-level object). */
export function detectFromObject(o) {
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o)) return o.length ? detectFromObject(o[0]) : null;
  if (o.mapping && typeof o.mapping === 'object') return 'chatgpt';
  if (Array.isArray(o.chat_messages)) return 'claude';
  if (Array.isArray(o.conversations) && o.conversations.length) {
    const c = o.conversations[0];
    if (c && (Array.isArray(c.responses) || c.conversation)) return 'grok';
    return detectFromObject(c);
  }
  if (Array.isArray(o.responses) && (o.conversation || o.responses.some((r) => r && r.response))) return 'grok';
  const header = typeof o.header === 'string' ? o.header : '';
  if (/gemini|bard/i.test(header) || (Array.isArray(o.products) && o.products.some((p) => /gemini|bard/i.test(p)))) return 'gemini';
  if (Array.isArray(o.safeHtmlItem) || (typeof o.title === 'string' && /^(Prompted|Asked|Said)\b/.test(o.title) && o.time)) return 'gemini';
  return null;
}

const base = (p) => p.split('/').pop();

/** From the file names inside a zip, which entries should be read and as what. */
export function pickEntries(names) {
  const files = names.filter((n) => !n.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(n) && !base(n).startsWith('._'));
  const picks = [];
  for (const n of files) {
    const b = base(n);
    if (/^conversations(-\d+)?\.json$/i.test(b)) picks.push({ name: n, kind: 'json', hint: null });
    else if (/prod-grok-backend\.json$/i.test(b)) picks.push({ name: n, kind: 'json', hint: 'grok' });
    else if (/^MyActivity\.(json|html)$/i.test(b) && /(gemini|bard)/i.test(n)) picks.push({ name: n, kind: b.toLowerCase().endsWith('.html') ? 'html' : 'json', hint: 'gemini' });
  }
  // Takeout ships both MyActivity.json and MyActivity.html when both were chosen: read the JSON only.
  const dirsWithJson = new Set(picks.filter((p) => p.hint === 'gemini' && p.kind === 'json').map((p) => p.name.slice(0, p.name.lastIndexOf('/'))));
  const out = picks.filter((p) => !(p.hint === 'gemini' && p.kind === 'html' && dirsWithJson.has(p.name.slice(0, p.name.lastIndexOf('/')))));
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

/* ------------------------------------------------------------------ ChatGPT */

const PUA_ENTITY = /entity(\[[\s\S]*?\])/g;
const PUA_SPAN = /[\s\S]*?/g;
const PUA_LEFT = /[-]/g;

/** ChatGPT embeds citations and entity links in private-use characters. */
export function cleanChatGPTText(s) {
  return s
    .replace(PUA_ENTITY, (_, json) => { try { const a = JSON.parse(json); return typeof a[1] === 'string' ? a[1] : ''; } catch { return ''; } })
    .replace(PUA_SPAN, '')
    .replace(PUA_LEFT, '');
}

/**
 * The messages of the branch the user was last looking at.
 * Walks from `current_node` up through `parent`. When current_node is missing or unknown it
 * walks down from the root taking the newest child each time (children are stored oldest first).
 */
export function chatgptBranch(mapping, currentNode) {
  const chain = [];
  const seen = new Set();
  if (currentNode && mapping[currentNode]) {
    let id = currentNode;
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      chain.push(mapping[id]);
      id = mapping[id].parent;
    }
    chain.reverse();
    return chain;
  }
  const ids = Object.keys(mapping);
  let root = ids.find((id) => !mapping[id].parent || !mapping[mapping[id].parent]);
  while (root && mapping[root] && !seen.has(root)) {
    seen.add(root);
    chain.push(mapping[root]);
    const kids = (mapping[root].children || []).filter((k) => mapping[k]);
    root = kids[kids.length - 1];
  }
  return chain;
}

function assetName(pointer) {
  const m = /([A-Za-z0-9_-]+)$/.exec(String(pointer ?? ''));
  return m ? m[1] : 'image';
}

function chatgptContent(content) {
  if (!content || typeof content !== 'object') return { text: '', atts: [] };
  const type = content.content_type;
  const atts = [];
  let text = '';
  switch (type) {
    case 'text':
    case 'multimodal_text': {
      const out = [];
      for (const p of content.parts || []) {
        if (typeof p === 'string') { if (p) out.push(p); continue; }
        if (!p || typeof p !== 'object') continue;
        if (p.content_type === 'image_asset_pointer') {
          const prompt = p.metadata?.dalle?.prompt;
          const name = assetName(p.asset_pointer);
          out.push(prompt ? `[Image: ${name}. Prompt: ${prompt}]` : `[Image: ${name}]`);
        } else if (p.content_type === 'audio_transcription' && typeof p.text === 'string') out.push(p.text);
        else if (/audio/.test(p.content_type || '')) out.push('[Audio]');
        else if (/video/.test(p.content_type || '')) out.push('[Video]');
        else if (typeof p.text === 'string') out.push(p.text);
      }
      text = out.join('\n\n');
      break;
    }
    case 'code':
      text = content.text ? fence(content.text, content.language && content.language !== 'unknown' ? content.language : '') : '';
      break;
    case 'execution_output':
      text = content.text ? fence(content.text) : '';
      break;
    case 'tether_browsing_display':
      text = content.result || content.summary || '';
      break;
    case 'tether_quote':
      text = [content.title, content.url, content.text].filter(Boolean).join('\n');
      break;
    case 'system_error':
      text = `[Error: ${content.name || 'system error'}${content.text ? ` ${content.text}` : ''}]`;
      break;
    case 'thoughts': case 'reasoning_recap': case 'user_editable_context': case 'model_editable_context':
      text = ''; // hidden reasoning summaries and custom-instruction plumbing are not conversation
      break;
    default:
      if (typeof content.text === 'string') text = content.text;
      else if (Array.isArray(content.parts)) text = content.parts.filter((p) => typeof p === 'string').join('\n\n');
  }
  return { text: cleanChatGPTText(text).trim(), atts };
}

export function normalizeChatGPT(conv, index = 0) {
  const mapping = conv.mapping || {};
  const messages = [];
  let model = conv.default_model_slug || null;
  for (const node of chatgptBranch(mapping, conv.current_node)) {
    const m = node.message;
    if (!m) continue;
    const meta = m.metadata || {};
    if (meta.is_visually_hidden_from_conversation) continue;
    const authorRole = m.author?.role;
    if (authorRole === 'system') continue;
    const { text } = chatgptContent(m.content);
    const atts = (meta.attachments || []).filter((a) => a && a.name).map((a) => ({ name: String(a.name), mime: a.mime_type || a.mimeType || '', size: Number.isFinite(a.size) ? a.size : null }));
    if (!text && !atts.length) continue;
    let role;
    if (authorRole === 'user') role = 'user';
    else if (authorRole === 'tool') role = 'tool';
    else if (authorRole === 'assistant') role = m.recipient && m.recipient !== 'all' ? 'tool' : 'assistant';
    else continue;
    if (role === 'assistant' && meta.model_slug) model = meta.model_slug;
    messages.push({ role, text, time: toMs(m.create_time), atts, tool: role === 'tool' ? (m.recipient && m.recipient !== 'all' ? m.recipient : m.author?.name || 'tool') : undefined });
  }
  return {
    id: String(conv.conversation_id || conv.id || `chatgpt-${index}`),
    source: 'chatgpt',
    title: String(conv.title || 'Untitled'),
    created: toMs(conv.create_time),
    updated: toMs(conv.update_time) ?? toMs(conv.create_time),
    model,
    extra: { archived: !!conv.is_archived, gpt: conv.gizmo_id || null },
    messages,
  };
}

/* ------------------------------------------------------------------ Claude */

function claudeBlocks(m) {
  const atts = [];
  const out = [];
  if (Array.isArray(m.content) && m.content.length) {
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'tool_use') out.push(fence(JSON.stringify(b.input ?? {}, null, 2), 'json').replace(/^/, `Tool call: ${b.name || 'tool'}\n\n`));
      else if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content) ? b.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : typeof b.content === 'string' ? b.content : '';
        if (inner.trim()) out.push(`Tool result:\n\n${fence(inner.slice(0, 20000))}`);
      } else if (b.type === 'image') out.push('[Image]');
      // 'thinking' blocks are skipped
    }
  }
  let text = out.join('\n\n').trim();
  if (!text && typeof m.text === 'string') text = m.text.trim();
  for (const a of m.attachments || []) if (a && a.file_name) atts.push({ name: String(a.file_name), mime: a.file_type || '', size: Number.isFinite(a.file_size) ? a.file_size : null });
  for (const f of m.files || []) if (f && (f.file_name || f.name)) atts.push({ name: String(f.file_name || f.name), mime: '', size: null });
  return { text, atts };
}

export function normalizeClaude(conv, index = 0) {
  const messages = [];
  for (const m of conv.chat_messages || []) {
    if (!m) continue;
    const { text, atts } = claudeBlocks(m);
    if (!text && !atts.length) continue;
    messages.push({ role: m.sender === 'human' ? 'user' : 'assistant', text, time: toMs(m.created_at), atts });
  }
  return {
    id: String(conv.uuid || conv.id || `claude-${index}`),
    source: 'claude',
    title: String(conv.name || 'Untitled'),
    created: toMs(conv.created_at),
    updated: toMs(conv.updated_at) ?? toMs(conv.created_at),
    model: null,
    extra: { summary: conv.summary || null },
    messages,
  };
}

/* ------------------------------------------------------------------ Gemini (Takeout > My Activity) */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A small HTML to Markdown converter for the response HTML in Takeout. No DOM needed, so it runs in a worker. */
export function htmlToMarkdown(html) {
  let s = String(html ?? '');
  s = s.replace(/<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_, c) => `\n\n${fence(decodeEntities(c.replace(/<[^>]+>/g, '')))}\n\n`);
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`);
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|ul|ol|table|tr)>/gi, '\n\n');
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const PROMPT_PREFIX = /^(Prompted|Asked|Said)\s+/;

function geminiItem(it) {
  const title = typeof it.title === 'string' ? it.title : '';
  const m = PROMPT_PREFIX.exec(title);
  const prompt = m ? title.slice(m[0].length).trim() : '';
  const html = Array.isArray(it.safeHtmlItem) ? it.safeHtmlItem.map((x) => x?.html || '').join('\n') : typeof it.description === 'string' ? it.description : '';
  const response = htmlToMarkdown(html);
  const atts = (it.attachedFiles || []).map((f) => ({ name: String(typeof f === 'string' ? f : f?.name || f), mime: '', size: null }));
  return { prompt, response, atts, time: toMs(it.time) };
}

/**
 * Groups My Activity items into sessions. Items closer together than gapMinutes belong to one session;
 * gapMinutes 0 makes every prompt its own conversation. Takeout has no conversation ids, so this is a heuristic.
 */
export function groupGemini(items, gapMinutes = 30) {
  const rows = items.map(geminiItem).filter((r) => r.prompt || r.response).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const groups = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || gapMinutes <= 0 || (r.time != null && cur.last != null && (r.time - cur.last) / 60000 > gapMinutes)) {
      cur = { rows: [], last: null };
      groups.push(cur);
    }
    cur.rows.push(r);
    cur.last = r.time ?? cur.last;
  }
  return groups.map((g, i) => {
    const messages = [];
    for (const r of g.rows) {
      if (r.prompt || r.atts.length) messages.push({ role: 'user', text: r.prompt, time: r.time, atts: r.atts });
      if (r.response) messages.push({ role: 'assistant', text: r.response, time: r.time, atts: [] });
    }
    const first = g.rows[0];
    const title = (first.prompt || first.response).replace(/\s+/g, ' ').slice(0, 80) || 'Untitled';
    return {
      id: `gemini-${first.time ?? 'x'}-${i}`,
      source: 'gemini', title, created: first.time, updated: g.last ?? first.time, model: null,
      extra: { grouped: gapMinutes > 0 }, messages,
    };
  });
}

/** MyActivity.html: one outer-cell per activity, first content-cell is "Prompted ...<br>date<br>response". */
export function parseGeminiHtml(html) {
  const items = [];
  const cells = html.split(/<div class="outer-cell/).slice(1);
  for (const cell of cells) {
    const m = /<div class="content-cell[^"]*body-1">([\s\S]*?)<\/div>/.exec(cell);
    if (!m) continue;
    const parts = m[1].split(/<br\s*\/?>/i);
    if (parts.length < 2) continue;
    const title = decodeEntities(parts[0].replace(/<[^>]+>/g, '')).trim();
    const time = decodeEntities(parts[1].replace(/<[^>]+>/g, '')).trim();
    const body = parts.slice(2).join('<br>');
    const iso = toMs(time);
    items.push({ title, time: iso == null ? null : new Date(iso).toISOString(), safeHtmlItem: body.trim() ? [{ html: body }] : [] });
  }
  return items;
}

/* ------------------------------------------------------------------ Grok */

export function grokConversations(doc) {
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc?.conversations)) return doc.conversations;
  return [];
}

export function normalizeGrok(entry, index = 0) {
  const meta = entry.conversation || entry;
  const rows = (entry.responses || []).map((r) => r?.response || r).filter(Boolean);
  const messages = rows.map((r) => {
    const sender = String(r.sender || r.role || '').toLowerCase();
    const atts = [...(r.file_attachments || []), ...(r.image_attachments || [])].map((a) => ({ name: String(typeof a === 'string' ? a : a?.file_name || a?.name || a), mime: '', size: null }));
    return { role: sender === 'human' || sender === 'user' ? 'user' : 'assistant', text: String(r.message ?? r.text ?? '').trim(), time: toMs(r.create_time ?? r.created_at), atts, model: r.model || null };
  }).filter((m) => m.text || m.atts.length);
  if (messages.every((m) => m.time != null)) messages.sort((a, b) => a.time - b.time);
  const model = [...messages].reverse().find((m) => m.model)?.model ?? null;
  return {
    id: String(meta.id || meta.conversation_id || `grok-${index}`),
    source: 'grok',
    title: String(meta.title || meta.name || 'Untitled'),
    created: toMs(meta.create_time ?? meta.created_at) ?? messages[0]?.time ?? null,
    updated: toMs(meta.modify_time ?? meta.update_time ?? meta.updated_at) ?? messages.at(-1)?.time ?? null,
    model, extra: {},
    messages: messages.map(({ model: _m, ...rest }) => rest),
  };
}

/* ------------------------------------------------------------------ summaries */

export function summarize(c) {
  let chars = 0;
  for (const m of c.messages) chars += m.text.length;
  const firstUser = c.messages.find((m) => m.role === 'user' && m.text);
  return {
    id: c.id, source: c.source, title: c.title, created: c.created, updated: c.updated,
    count: c.messages.length, chars,
    preview: (firstUser ? firstUser.text : c.messages[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 140),
  };
}
