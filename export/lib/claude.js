// "Move to Claude": turns chosen chats into files meant to be added to a Claude Project's knowledge.
import { toMarkdown, chatFileName } from './export.js';
import { SOURCE_LABEL, isoDate, uniqueNamer } from './util.js';

export const CHARS_PER_TOKEN = 4; // a rough rule of thumb; real tokenizers differ by language and content

export const DEFAULTS = {
  mode: 'combined',          // 'combined' | 'perChat'
  budgetTokens: 150_000,     // total across all files; 0 = no limit
  maxFileChars: 600_000,     // each combined part stays under this
  compact: true,             // drop tool messages, trim very long messages
  maxMessageChars: 6000,
};

function preamble(label, part, parts) {
  return [
    `# ${label} chat history${parts > 1 ? ` (part ${part} of ${parts})` : ''}`, '',
    `These are past conversations exported from ${label}. Each conversation starts with a heading "Conversation:" followed by its title and date.`,
    'Use them as background about what I have worked on, decided and asked before. Quote them only when they are relevant.', '',
  ].join('\n');
}

/** One conversation as a block of Markdown. Headings are pushed down one level so each chat is a single section. */
function block(conv, opts) {
  const md = toMarkdown(conv, { compact: opts.compact, maxMessageChars: opts.compact ? opts.maxMessageChars : 0 });
  const lines = md.split('\n');
  lines[0] = `# Conversation: ${conv.title.replace(/\s+/g, ' ')}`;
  return lines.join('\n').replace(/^## /gm, '### ');
}

/** Splits an over-long block into pieces at message boundaries (and hard-splits a single huge message). */
function splitBlock(text, max) {
  if (text.length <= max) return [text];
  const pieces = [];
  const sections = text.split(/\n(?=---\n\n### )/);
  let cur = '';
  const flush = () => { if (cur) { pieces.push(cur); cur = ''; } };
  for (const s of sections) {
    if (s.length > max) {
      flush();
      for (let i = 0; i < s.length; i += max) pieces.push(s.slice(i, i + max));
    } else if (cur.length + s.length + 1 > max) { flush(); cur = s; } else cur = cur ? `${cur}\n${s}` : s;
  }
  flush();
  return pieces;
}

export function projectInstructions(label) {
  return `The knowledge files in this project are my past ${label} conversations, exported and cleaned up. When I ask about something we may have covered before, search them first and say which conversation (title and date) you found it in. If the files do not cover it, say so instead of guessing. Do not repeat the files back to me unless I ask.\n`;
}

export function readme({ label, report, mode, compact }) {
  return `# Add this to a Claude Project

You exported ${report.included} of ${report.total} ${label} chats${report.omitted ? ` (${report.omitted} did not fit the size limit and are listed in 00-index.md)` : ''}.
The files in the "upload-these" folder are the ones to add. This file and the instructions file are for you.

## Steps

1. Open Claude (claude.ai) and choose Projects, then create a new project. Give it a name such as "${label} history".
2. In the project, find the knowledge section ("Add content" or the "+" next to project knowledge) and choose to upload files.
3. Select every file in the "upload-these" folder and upload them.
4. Open the project's instructions and paste the text from "project-instructions.txt".
5. Ask Claude something you remember discussing, for example "What did we decide about ...?" and check that it names the right conversation.

## About the files

- Mode: ${mode === 'combined' ? 'combined, several conversations per file' : 'one file per conversation'}.
- Approximate size: ${report.approxTokens.toLocaleString('en-US')} tokens (counted as 1 token per ${CHARS_PER_TOKEN} characters; the real number differs).
- ${compact ? 'Compact mode was on: tool output was left out and very long messages were shortened.' : 'Compact mode was off: everything was kept.'}
- Claude's limits for project knowledge, file counts and file sizes change. If an upload is refused, export again with a smaller size limit. Check Anthropic's help pages for the current numbers.
- This was built in your browser. Nothing was uploaded anywhere until you add the files to Claude yourself.
`;
}

/**
 * @param {object[]} convs   in the order they should be filled (most useful first)
 * @param {object} options
 * @returns {{ files: {path: string, text: string}[], report: object }}
 */
export function buildClaudePackage(convs, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const sources = [...new Set(convs.map((c) => c.source))];
  const label = sources.length === 1 ? SOURCE_LABEL[sources[0]] : 'AI';
  const budgetChars = o.budgetTokens > 0 ? o.budgetTokens * CHARS_PER_TOKEN : Infinity;
  const name = uniqueNamer();

  const included = [];
  const omitted = [];
  let used = 0;
  const blocks = [];
  for (const c of convs) {
    const text = block(c, o);
    if (used + text.length > budgetChars) { omitted.push(c); continue; }
    used += text.length;
    included.push(c);
    blocks.push({ conv: c, text });
  }

  const files = [];
  const where = new Map(); // conv id -> file names
  if (o.mode === 'perChat') {
    for (const b of blocks) {
      const file = name(chatFileName(b.conv, 'md'));
      files.push({ path: `upload-these/${file}`, text: b.text });
      where.set(b.conv.id, [file]);
    }
  } else {
    // Pack blocks into parts, each under maxFileChars (leaving room for the preamble).
    const room = Math.max(10_000, o.maxFileChars - 1200);
    const parts = [];
    let cur = { items: [], size: 0 };
    const push = () => { if (cur.items.length) { parts.push(cur); cur = { items: [], size: 0 }; } };
    for (const b of blocks) {
      for (const piece of splitBlock(b.text, room)) {
        if (cur.size + piece.length + 2 > room) push();
        cur.items.push({ id: b.conv.id, text: piece });
        cur.size += piece.length + 2;
      }
    }
    push();
    parts.forEach((p, i) => {
      const file = `history-part-${String(i + 1).padStart(2, '0')}.md`;
      files.push({ path: `upload-these/${file}`, text: `${preamble(label, i + 1, parts.length)}\n${p.items.map((x) => x.text).join('\n\n')}\n` });
      for (const it of p.items) {
        const list = where.get(it.id) || [];
        if (!list.includes(file)) list.push(file);
        where.set(it.id, list);
      }
    });
  }

  const idx = ['# Index of conversations', ''];
  for (const c of included) idx.push(`- ${c.title.replace(/\s+/g, ' ')}${c.created != null ? ` (${isoDate(c.created)})` : ''}: ${where.get(c.id).join(', ')}`);
  if (omitted.length) {
    idx.push('', '## Not included (over the size limit)', '');
    for (const c of omitted) idx.push(`- ${c.title.replace(/\s+/g, ' ')}${c.created != null ? ` (${isoDate(c.created)})` : ''}`);
  }
  files.push({ path: 'upload-these/00-index.md', text: `${idx.join('\n')}\n` });

  const chars = files.filter((f) => f.path.startsWith('upload-these/')).reduce((n, f) => n + f.text.length, 0);
  const report = {
    total: convs.length, included: included.length, omitted: omitted.length,
    files: files.length, chars, approxTokens: Math.round(chars / CHARS_PER_TOKEN),
  };
  files.push({ path: 'README-add-to-claude.md', text: readme({ label, report, mode: o.mode, compact: o.compact }) });
  files.push({ path: 'project-instructions.txt', text: projectInstructions(label) });
  return { files, report };
}
