// The worker. Parsing, searching and building export files happen here so the page stays responsive on big exports.
// scripts/build-export.mjs bundles this file, the modules in lib/ and JSZip into worker-bundle.js.
// The page starts that bundle from a blob: URL, which makes the worker obey the page's Content-Security-Policy.
import { claudeZip, bulkZip, searchConversations, singleExport, PRO_REQUIRED } from './lib/ops.js';
import { loadSource } from './lib/load.js';
import { summarize } from './lib/parse.js';

const state = { convs: new Map() };

function post(id, body, transfer) { self.postMessage({ id, ...body }, transfer); }

function pick(ids) {
  const out = [];
  for (const id of ids) { const c = state.convs.get(id); if (c) out.push(c); }
  return out;
}

const handlers = {
  async load(m, id) {
    state.convs = new Map();
    let last = 0;
    const result = await loadSource(m.file, {
      geminiGapMinutes: m.geminiGapMinutes,
      onProgress: (p) => {
        const now = Date.now();
        if (p.phase === 'read' && now - last < 80) return;
        last = now;
        post(id, { progress: p });
      },
    });
    for (const c of result.conversations) state.convs.set(c.id, c);
    return { summaries: result.conversations.map(summarize), formats: result.formats, warnings: result.warnings, files: result.files };
  },
  async get(m) {
    const conv = state.convs.get(m.convId);
    if (!conv) throw new Error('That chat is not loaded.');
    return { conv };
  },
  async search(m) { return { results: searchConversations([...state.convs.values()], m.q), q: m.q }; },
  async single(m) { return singleExport(state.convs.get(m.convId), m.format); },
  async bulk(m, id) {
    const blob = await bulkZip(self.JSZip, pick(m.ids), {
      format: m.format, pro: m.pro === true, frontmatter: !!m.frontmatter,
      onProgress: (done, total) => post(id, { progress: { phase: 'build', done, total } }),
    });
    return { blob, filename: `threadkeep-export-${m.format}.zip` };
  },
  async claude(m) {
    const { blob, report } = await claudeZip(self.JSZip, pick(m.ids), { ...m.options, pro: m.pro === true });
    return { blob, report, filename: 'threadkeep-for-claude.zip' };
  },
  // Used by tests to prove the worker cannot reach the network under the page's CSP.
  async netprobe(m) {
    try { await fetch(m.url, { mode: 'no-cors' }); return { reached: true }; } catch (e) { return { reached: false, error: String(e) }; }
  },
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const fn = handlers[m.type];
    if (!fn) throw new Error(`Unknown request ${m.type}`);
    post(m.id, { ok: true, ...(await fn(m, m.id)) });
  } catch (err) {
    post(m.id, { ok: false, error: String(err?.message || err), code: err?.code === PRO_REQUIRED ? PRO_REQUIRED : undefined });
  }
};
