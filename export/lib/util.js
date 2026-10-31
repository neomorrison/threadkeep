// Small helpers shared by the parsers, exporters and UI. No DOM, no browser APIs.

export const SOURCE_LABEL = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' };

/** Seconds, milliseconds, ISO strings and Mongo-style {$date} / {seconds} objects to ms since epoch, or null. */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toMs(Number(v));
    const t = Date.parse(v.replace(/ /g, ' '));
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'object') {
    if ('$date' in v) return toMs(v.$date);
    if ('$numberLong' in v) return toMs(Number(v.$numberLong));
    if ('seconds' in v) return toMs(Number(v.seconds) + Number(v.nanos || 0) / 1e9);
  }
  return null;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

/** 2025-01-02 (UTC) or ''. */
export function isoDate(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 2025-01-02 10:04 UTC or ''. */
export function isoDateTime(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${isoDate(ms)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** A safe file name stem: letters, digits, dashes. Never empty. */
export function slug(s, max = 60) {
  const out = String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return out || 'untitled';
}

/** Wraps code in a fence longer than any backtick run inside it. */
export function fence(code, lang = '') {
  let longest = 2;
  for (const m of String(code).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${String(code).replace(/\n+$/, '')}\n${f}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Gives every name in a list a unique version (a.md, a-2.md, ...), case-insensitively. */
export function uniqueNamer() {
  const seen = new Set();
  return (name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let i = 2; seen.has(candidate.toLowerCase()); i++) candidate = `${stem}-${i}${ext}`;
    seen.add(candidate.toLowerCase());
    return candidate;
  };
}

/** Search terms from a query: words, or "quoted phrases" kept together. Lowercased. */
export function parseQuery(q) {
  const terms = [];
  for (const m of String(q).matchAll(/"([^"]+)"|(\S+)/g)) terms.push((m[1] ?? m[2]).toLowerCase());
  return terms;
}
