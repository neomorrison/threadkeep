// Reads a dropped file (a zip, a conversations.json, or Takeout's MyActivity file) into normalized conversations.
// Runs inside the worker. Needs JSZip on the global scope when the input is a zip.
import { JsonStreamSplitter } from './stream.js';
import {
  detectFromObject, grokConversations, groupGemini, normalizeChatGPT, normalizeClaude, normalizeGrok,
  parseGeminiHtml, pickEntries,
} from './parse.js';

const MAX_WHOLE_BYTES = 400 * 1024 * 1024; // top-level objects and HTML are read as one string

/** Feeds an async source of text chunks to a callback. */
async function readBlobText(blob, onText, onBytes) {
  const reader = blob.stream().getReader();
  const dec = new TextDecoder('utf-8');
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    onText(dec.decode(value, { stream: true }));
    onBytes(seen);
  }
  onText(dec.decode());
}

function readZipEntryText(entry, onText, onBytes) {
  return new Promise((resolve, reject) => {
    const dec = new TextDecoder('utf-8');
    let seen = 0;
    entry.internalStream('uint8array')
      .on('data', (chunk) => { seen += chunk.length; onText(dec.decode(chunk, { stream: true })); onBytes(seen); })
      .on('error', reject)
      .on('end', () => { onText(dec.decode()); resolve(); })
      .resume();
  });
}

/**
 * @param {Blob} file
 * @param {{ geminiGapMinutes?: number, onProgress?: (p: {phase: string, done: number, total: number, file?: string}) => void }} opts
 * @returns {Promise<{ conversations: object[], formats: string[], warnings: string[], files: string[] }>}
 */
export async function loadSource(file, opts = {}) {
  const { geminiGapMinutes = 30, onProgress = () => {} } = opts;
  const warnings = [];
  const conversations = [];
  const geminiItems = [];
  const formats = new Set();
  const usedFiles = [];
  let skipped = 0;
  let idx = 0;

  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;

  /** Reads one JSON stream: `read(onText, onBytes)` supplies chunks. */
  async function ingestJson(label, size, hint, read) {
    let format = hint;
    const take = (text) => {
      let c;
      try {
        const obj = JSON.parse(text);
        format = format || detectFromObject(obj);
        if (format === 'chatgpt') c = normalizeChatGPT(obj, idx);
        else if (format === 'claude') c = normalizeClaude(obj, idx);
        else if (format === 'gemini') { geminiItems.push(obj); return; }
        else if (format === 'grok') c = normalizeGrok(obj, idx);
        else { skipped++; return; }
      } catch { skipped++; return; }
      idx++;
      conversations.push(c);
    };
    const splitter = new JsonStreamSplitter(take);
    await read((t) => splitter.feed(t), (b) => onProgress({ phase: 'read', done: b, total: size, file: label }));
    const whole = splitter.end();
    if (whole != null) {
      if (whole.length > MAX_WHOLE_BYTES) throw new Error(`${label} is too large to open as one document.`);
      let doc;
      try { doc = JSON.parse(whole); } catch { throw new Error(`${label} is not valid JSON.`); }
      format = format || detectFromObject(doc);
      if (format === 'grok' || (!format && Array.isArray(doc?.conversations))) {
        format = 'grok';
        for (const e of grokConversations(doc)) { conversations.push(normalizeGrok(e, idx++)); }
      } else if (format === 'chatgpt') conversations.push(normalizeChatGPT(doc, idx++));
      else if (format === 'claude') conversations.push(normalizeClaude(doc, idx++));
      else { warnings.push(`${label}: the format was not recognized.`); return; }
    }
    if (format) formats.add(format);
    usedFiles.push(label);
  }

  async function ingestHtml(label, size, read) {
    const parts = [];
    await read((t) => parts.push(t), (b) => onProgress({ phase: 'read', done: b, total: size, file: label }));
    const items = parseGeminiHtml(parts.join(''));
    geminiItems.push(...items);
    formats.add('gemini');
    usedFiles.push(label);
  }

  if (isZip) {
    const JSZip = globalThis.JSZip;
    if (!JSZip) throw new Error('The zip reader is missing.');
    onProgress({ phase: 'unzip', done: 0, total: file.size });
    let buf;
    try { buf = await file.arrayBuffer(); } catch { throw new Error('This zip is too large for the browser to open (the limit is about 2 GB). Unzip it and drop conversations.json instead.'); }
    let zip;
    try { zip = await JSZip.loadAsync(buf); } catch { throw new Error('This zip could not be opened. It may be damaged, or still downloading.'); }
    const picks = pickEntries(Object.keys(zip.files));
    if (!picks.length) throw new Error('No conversations.json, MyActivity file or Grok export was found in this zip.');
    for (const p of picks) {
      const entry = zip.files[p.name];
      const size = entry._data?.uncompressedSize || 0;
      const read = (onText, onBytes) => readZipEntryText(entry, onText, onBytes);
      if (p.kind === 'html') await ingestHtml(p.name, size, read);
      else await ingestJson(p.name, size, p.hint, read);
    }
  } else {
    const name = file.name || 'file';
    const read = (onText, onBytes) => readBlobText(file, onText, onBytes);
    if (/\.html?$/i.test(name)) await ingestHtml(name, file.size, read);
    else await ingestJson(name, file.size, null, read);
  }

  if (geminiItems.length) {
    const groups = groupGemini(geminiItems, geminiGapMinutes);
    for (const g of groups) conversations.push(g);
  }
  if (skipped) warnings.push(`${skipped} item${skipped === 1 ? '' : 's'} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped.`);
  if (!conversations.length && !warnings.length) warnings.push('No conversations were found in this file.');

  // Ids must be unique: the same id can appear twice when exports are merged.
  const seen = new Set();
  for (const c of conversations) {
    let id = c.id;
    for (let n = 2; seen.has(id); n++) id = `${c.id}~${n}`;
    seen.add(id);
    c.id = id;
  }
  onProgress({ phase: 'done', done: 1, total: 1 });
  return { conversations, formats: [...formats], warnings, files: usedFiles };
}
