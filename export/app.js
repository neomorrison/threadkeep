// The export tool's page. Everything runs here and in a worker; no chat data leaves the browser.
import { createLicense } from './lib/license.js';
import { renderMessageText } from './lib/render.js';
import { SOURCE_LABEL, formatBytes, isoDateTime, parseQuery } from './lib/util.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/* ---------------------------------------------------------------- worker */

const worker = (() => {
  const blob = new Blob([self.TK_WORKER_SRC], { type: 'text/javascript' });
  const w = new Worker(URL.createObjectURL(blob));
  const pending = new Map();
  let n = 0;
  w.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress) { p.onProgress?.(m.progress); return; }
    pending.delete(m.id);
    if (m.ok) p.resolve(m); else p.reject(Object.assign(new Error(m.error || 'Something went wrong.'), { code: m.code }));
  };
  w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'The worker stopped.')); pending.clear(); };
  return {
    call(type, payload = {}, onProgress) {
      const id = ++n;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); w.postMessage({ id, type, ...payload }); });
    },
  };
})();
window.__tk = { worker, workerKind: 'blob' }; // read by tests

/* ---------------------------------------------------------------- state */

const state = {
  file: null, summaries: [], byId: new Map(), formats: [],
  selected: new Set(), activeId: null, search: null, shown: 150, geminiGap: 30,
};
const license = createLicense({
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  label: `ThreadKeep web export on ${navigator.userAgentData?.platform || navigator.platform || 'browser'}`,
});

/* ---------------------------------------------------------------- helpers */

function download(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
const fmtDate = (ms) => (ms == null ? '' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

function say(msg, kind = 'info') {
  const s = $('#status');
  s.textContent = msg; s.dataset.kind = kind; s.hidden = !msg;
}

/* ---------------------------------------------------------------- loading */

const drop = $('#drop');
const work = $('#work');
const fileInput = $('#file');

async function openFile(file) {
  state.file = file;
  say('');
  drop.dataset.busy = '1';
  const prog = $('#progress'); prog.hidden = false; prog.removeAttribute('value');
  $('#busy').textContent = `Reading ${file.name} (${formatBytes(file.size)}). It stays on this computer.`;
  try {
    const r = await worker.call('load', { file, geminiGapMinutes: state.geminiGap }, (p) => {
      if (p.phase === 'read' && p.total) { prog.max = p.total; prog.value = Math.min(p.done, p.total); }
      if (p.phase === 'unzip') $('#busy').textContent = `Opening ${file.name}...`;
    });
    state.summaries = r.summaries; state.formats = r.formats; state.byId = new Map(r.summaries.map((s) => [s.id, s]));
    state.selected = new Set(); state.activeId = null; state.search = null; state.shown = 150;
    if (!r.summaries.length) throw new Error(r.warnings.join(' ') || 'No conversations were found in this file.');
    showWorkspace(r);
    if (r.warnings.length) say(r.warnings.join(' '), 'warn');
  } catch (e) {
    say(e.message, 'error');
  } finally {
    delete drop.dataset.busy; prog.hidden = true;
  }
}

function showWorkspace(r) {
  drop.hidden = true; work.hidden = false;
  const total = state.summaries.reduce((n, s) => n + s.count, 0);
  const names = state.formats.map((f) => SOURCE_LABEL[f]).join(' + ');
  $('#fileName').textContent = state.file.name;
  $('#counts').textContent = `${names || 'Chats'}: ${plural(state.summaries.length, 'chat')}, ${plural(total, 'message')}`;
  const sources = [...new Set(state.summaries.map((s) => s.source))];
  const sel = $('#fSource'); sel.replaceChildren(new Option('All sources', ''));
  for (const s of sources) sel.append(new Option(SOURCE_LABEL[s], s));
  sel.hidden = sources.length < 2;
  $('#gapRow').hidden = !state.formats.includes('gemini');
  $('#q').value = ''; $('#fFrom').value = ''; $('#fTo').value = '';
  renderReader(null);
  renderList();
}

/* ---------------------------------------------------------------- list */

function visible() {
  const source = $('#fSource').value;
  const from = $('#fFrom').value ? Date.parse(`${$('#fFrom').value}T00:00:00Z`) : null;
  const to = $('#fTo').value ? Date.parse(`${$('#fTo').value}T23:59:59Z`) : null;
  const sort = $('#sort').value;
  let rows = state.summaries.filter((s) => {
    if (source && s.source !== source) return false;
    const t = s.updated ?? s.created;
    if (from != null && (t == null || t < from)) return false;
    if (to != null && (t == null || t > to)) return false;
    if (state.search && !state.search.map.has(s.id)) return false;
    return true;
  });
  const by = {
    new: (a, b) => (b.updated ?? 0) - (a.updated ?? 0), old: (a, b) => (a.created ?? 0) - (b.created ?? 0),
    az: (a, b) => a.title.localeCompare(b.title), long: (a, b) => b.count - a.count,
    rel: (a, b) => (state.search.map.get(b.id).hits - state.search.map.get(a.id).hits),
  };
  rows = rows.sort(sort === 'rel' && state.search ? by.rel : by[sort === 'rel' ? 'new' : sort]);
  return rows;
}

function renderList() {
  const rows = visible();
  state.visibleIds = rows.map((r) => r.id);
  const ul = $('#list');
  ul.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const s of rows.slice(0, state.shown)) {
    const li = el('li', 'row'); li.dataset.id = s.id;
    if (s.id === state.activeId) li.classList.add('on');
    const label = el('label', 'ck');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.selected.has(s.id); cb.setAttribute('aria-label', `Select ${s.title}`);
    label.append(cb);
    const open = el('button', 'open'); open.type = 'button';
    open.append(el('span', 't', s.title));
    const meta = el('span', 'm');
    const sq = el('i', `sq ${s.source}`); meta.append(sq, `${[fmtDate(s.updated ?? s.created), plural(s.count, 'message')].filter(Boolean).join(' · ')}`);
    open.append(meta);
    const hit = state.search?.map.get(s.id);
    open.append(el('span', 'snip', hit?.snippet || s.preview));
    li.append(label, open);
    frag.append(li);
  }
  ul.append(frag);
  const more = $('#more');
  more.hidden = rows.length <= state.shown;
  more.textContent = `Show ${Math.min(150, rows.length - state.shown)} more`;
  $('#shownCount').textContent = state.search || rows.length !== state.summaries.length
    ? `${plural(rows.length, 'chat')} match` : plural(rows.length, 'chat');
  updateSelection();
}

function updateSelection() {
  const n = state.selected.size;
  const shown = state.visibleIds.length;
  const all = $('#selAll');
  const inView = state.visibleIds.filter((id) => state.selected.has(id)).length;
  all.checked = shown > 0 && inView === shown;
  all.indeterminate = inView > 0 && inView < shown;
  $('#selCount').textContent = n ? `${n.toLocaleString('en-US')} selected` : 'Select chats to export';
  $('#btnExport').disabled = $('#btnClaude').disabled = false;
}

$('#list').addEventListener('click', (e) => {
  const li = e.target.closest('.row');
  if (!li) return;
  if (e.target.matches('input[type=checkbox]')) {
    if (e.target.checked) state.selected.add(li.dataset.id); else state.selected.delete(li.dataset.id);
    updateSelection();
    return;
  }
  if (e.target.closest('.open')) openChat(li.dataset.id);
});
$('#selAll').addEventListener('change', (e) => {
  for (const id of state.visibleIds) { if (e.target.checked) state.selected.add(id); else state.selected.delete(id); }
  renderList();
});
$('#more').addEventListener('click', () => { state.shown += 150; renderList(); });
for (const id of ['#fSource', '#sort', '#fFrom', '#fTo']) $(id).addEventListener('change', () => { state.shown = 150; renderList(); });

let searchTimer = 0;
let searchSeq = 0;
$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});
async function runSearch() {
  const q = $('#q').value.trim();
  const seq = ++searchSeq;
  if (!q) {
    state.search = null;
    if ($('#sort').value === 'rel') $('#sort').value = 'new';
    $('#sort').querySelector('[value=rel]').hidden = true;
    state.shown = 150; renderList(); return;
  }
  $('#searching').hidden = false;
  try {
    const r = await worker.call('search', { q });
    if (seq !== searchSeq) return;
    state.search = { q, terms: parseQuery(q), map: new Map(r.results.map((x) => [x.id, x])) };
    $('#sort').querySelector('[value=rel]').hidden = false;
    $('#sort').value = 'rel';
    state.shown = 150; renderList();
    if (state.activeId && state.search.map.has(state.activeId)) openChat(state.activeId);
  } catch (e) { say(e.message, 'error'); } finally { if (seq === searchSeq) $('#searching').hidden = true; }
}

/* ---------------------------------------------------------------- reader */

let current = null;
async function openChat(id) {
  state.activeId = id;
  document.querySelectorAll('#list .row').forEach((r) => r.classList.toggle('on', r.dataset.id === id));
  try {
    const { conv } = await worker.call('get', { convId: id });
    current = conv;
    renderReader(conv);
    if (window.matchMedia('(max-width: 860px)').matches) $('#reader').scrollIntoView({ block: 'start' });
  } catch (e) { say(e.message, 'error'); }
}

function renderReader(conv, shown = 120) {
  const box = $('#reader');
  box.replaceChildren();
  if (!conv) {
    box.append(el('p', 'empty', state.summaries.length ? 'Choose a chat on the left to read it.' : ''));
    return;
  }
  const terms = state.search?.terms ?? [];
  const head = el('div', 'rhead');
  head.append(el('h2', null, conv.title));
  const meta = el('p', 'rmeta');
  const sq = el('i', `sq ${conv.source}`);
  meta.append(sq, [SOURCE_LABEL[conv.source], conv.created != null ? isoDateTime(conv.created) : '', conv.model, plural(conv.messages.length, 'message')].filter(Boolean).join(' · '));
  head.append(meta);
  const bar = el('div', 'rbar');
  const mk = (label, fn) => { const b = el('button', 'btn small ghost', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  bar.append(
    mk('Download Markdown', () => saveSingle('md')),
    mk('Download text', () => saveSingle('txt')),
    mk('Copy Markdown', async (e) => { const r = await worker.call('single', { convId: conv.id, format: 'md' }); try { await navigator.clipboard.writeText(r.text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy blocked by the browser'; } setTimeout(() => { e.target.textContent = 'Copy Markdown'; }, 1800); }),
  );
  head.append(bar);
  box.append(head);
  const list = el('div', 'msgs');
  const draw = (from, to) => {
    for (const m of conv.messages.slice(from, to)) {
      const a = el('article', `msg ${m.role}`);
      const who = el('div', 'who');
      who.append(el('b', null, m.role === 'user' ? 'You' : m.role === 'tool' ? `Tool${m.tool ? ` (${m.tool})` : ''}` : SOURCE_LABEL[conv.source]));
      if (m.time != null) who.append(el('time', null, isoDateTime(m.time)));
      a.append(who);
      const body = el('div', 'body');
      renderMessageText(body, m.text, terms);
      a.append(body);
      for (const f of m.atts) a.append(el('p', 'att', `Attachment: ${f.name}${f.size != null ? ` (${formatBytes(f.size)})` : ''}`));
      list.append(a);
    }
  };
  draw(0, shown);
  box.append(list);
  let next = shown;
  if (conv.messages.length > next) {
    const more = el('button', 'btn ghost', '');
    more.type = 'button';
    const label = () => { more.textContent = `Show the next ${Math.min(200, conv.messages.length - next)} messages`; };
    label();
    more.addEventListener('click', () => { draw(next, next + 200); next += 200; if (next >= conv.messages.length) more.remove(); else label(); });
    box.append(more);
  }
  box.scrollTop = 0;
  const firstHit = box.querySelector('mark');
  if (firstHit) firstHit.scrollIntoView({ block: 'center' });
}

async function saveSingle(format) {
  const r = await worker.call('single', { convId: current.id, format });
  download(new Blob([r.text], { type: r.mime }), r.filename);
}

/* ---------------------------------------------------------------- Pro */

function updatePro() {
  const pro = license.isPro();
  document.body.dataset.pro = pro ? '1' : '0';
  for (const b of document.querySelectorAll('[data-pro-label]')) b.textContent = pro ? 'Pro unlocked' : 'Unlock Pro';
}

async function activateFrom(form) {
  const input = form.querySelector('input[name=key]');
  const err = form.parentElement.querySelector('.err');
  const btn = form.querySelector('button[type=submit]');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Checking...';
  try {
    await license.activate(input.value);
    input.value = '';
    updatePro(); refreshDialogs();
  } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
}
for (const f of document.querySelectorAll('form.keyform')) f.addEventListener('submit', (e) => { e.preventDefault(); activateFrom(f); });
$('#removeKey').addEventListener('click', async () => { await license.remove(); updatePro(); refreshDialogs(); });

/* ---------------------------------------------------------------- bulk dialogs */

function scopeIds(form) {
  const v = form.elements.scope.value;
  if (v === 'selected') return [...state.selected];
  if (v === 'shown') return [...state.visibleIds];
  return state.summaries.map((s) => s.id);
}
function refreshDialogs() {
  const sel = state.selected.size, shown = state.visibleIds?.length ?? 0, all = state.summaries.length;
  for (const form of document.querySelectorAll('form.opts')) {
    const set = (v, text, disabled) => { const r = form.querySelector(`input[value=${v}]`); r.disabled = disabled; r.parentElement.lastChild.textContent = ` ${text}`; };
    set('selected', `Selected chats (${sel.toLocaleString('en-US')})`, sel === 0);
    set('shown', `Chats shown in the list (${shown.toLocaleString('en-US')})`, shown === 0);
    set('all', `Every chat (${all.toLocaleString('en-US')})`, all === 0);
    const cur = form.querySelector('input[name=scope]:checked');
    if (!cur || cur.disabled) form.querySelector(`input[value=${sel ? 'selected' : 'shown'}]`).checked = true;
  }
  const info = license.info();
  $('#keyInfo').textContent = info ? `Licensed key ${info.displayKey}` : '';
  for (const d of document.querySelectorAll('dialog')) d.dataset.pro = license.isPro() ? '1' : '0';
}
function openDialog(id) { refreshDialogs(); $(id).showModal(); }
$('#btnExport').addEventListener('click', () => openDialog('#dlgExport'));
$('#btnClaude').addEventListener('click', () => openDialog('#dlgClaude'));
$('#btnPro').addEventListener('click', () => openDialog('#dlgLicense'));
for (const b of document.querySelectorAll('dialog [data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

function setBuild(form, text, kind) { const o = form.querySelector('.out'); o.textContent = text; o.dataset.kind = kind || ''; }

$('#formExport').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (!license.isPro()) return;
  const ids = scopeIds(form);
  if (!ids.length) return setBuild(form, 'Choose some chats first.', 'error');
  const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    setBuild(form, 'Building...');
    const r = await worker.call('bulk', { ids, format: form.elements.format.value, frontmatter: form.elements.frontmatter.checked, pro: license.isPro() },
      (p) => setBuild(form, `Building ${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')}...`));
    download(r.blob, r.filename);
    setBuild(form, `Done: ${plural(ids.length, 'chat')} in ${r.filename} (${formatBytes(r.blob.size)}).`, 'ok');
  } catch (err) { setBuild(form, err.message, 'error'); } finally { btn.disabled = false; }
});

$('#formClaude').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (!license.isPro()) return;
  const ids = scopeIds(form).map((id) => state.byId.get(id)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).map((s) => s.id);
  if (!ids.length) return setBuild(form, 'Choose some chats first.', 'error');
  const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    setBuild(form, 'Building...');
    const r = await worker.call('claude', {
      ids, pro: license.isPro(),
      options: {
        mode: form.elements.mode.value, budgetTokens: Number(form.elements.budget.value),
        maxFileChars: Number(form.elements.filesize.value), compact: form.elements.compact.checked,
      },
    });
    download(r.blob, r.filename);
    const rp = r.report;
    setBuild(form, `Done: ${rp.included.toLocaleString('en-US')} of ${rp.total.toLocaleString('en-US')} chats, about ${rp.approxTokens.toLocaleString('en-US')} tokens.${rp.omitted ? ` ${rp.omitted.toLocaleString('en-US')} did not fit; they are listed in 00-index.md.` : ''} Open README-add-to-claude.md in the zip for the next steps.`, 'ok');
  } catch (err) { setBuild(form, err.message, 'error'); } finally { btn.disabled = false; }
});

/* ---------------------------------------------------------------- drop zone */

['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });
$('#pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) openFile(f); fileInput.value = ''; });
$('#another').addEventListener('click', () => { work.hidden = true; drop.hidden = false; say(''); });
$('#gap').addEventListener('change', () => { state.geminiGap = Number($('#gap').value); if (state.file) openFile(state.file); });

$('#sample').addEventListener('click', () => {
  const t = 1735722000;
  const chat = (id, title, pairs, base, model = 'gpt-4o') => {
    const mapping = { root: { id: 'root', message: null, parent: null, children: [] } };
    let prev = 'root', i = 0;
    for (const [role, text] of pairs) {
      const nid = `${id}-${i}`;
      mapping[prev].children.push(nid);
      mapping[nid] = { id: nid, parent: prev, children: [], message: { id: nid, author: { role }, create_time: base + i * 30, content: { content_type: 'text', parts: [text] }, metadata: role === 'assistant' ? { model_slug: model } : {}, recipient: 'all' } };
      prev = nid; i++;
    }
    return { title, create_time: base, update_time: base + i * 30, mapping, current_node: prev, conversation_id: id, default_model_slug: model };
  };
  const sample = [
    chat('s1', 'Retry decorator in Python', [['user', 'Write a Python decorator that retries a flaky function with exponential backoff.'], ['assistant', 'Here is a small decorator:\n\n```python\nimport time\n\ndef retry(times=5, base=0.5):\n    def wrap(fn):\n        def inner(*a, **kw):\n            for i in range(times):\n                try:\n                    return fn(*a, **kw)\n                except Exception:\n                    if i == times - 1:\n                        raise\n                    time.sleep(base * 2 ** i)\n        return inner\n    return wrap\n```\n\nIt waits **0.5s, 1s, 2s** and so on between tries.']], t),
    chat('s2', 'Lisbon packing list', [['user', 'What should I pack for a week in Lisbon in March?'], ['assistant', 'Pack layers:\n\n- a light rain jacket\n- comfortable shoes for steep cobblestones\n- a sweater for evenings']], t + 86400 * 20),
    chat('s3', 'Pricing page headline ideas', [['user', 'Give me five headline ideas for a one-time-payment pricing page.'], ['assistant', '1. Pay once. Keep it.\n2. No subscription, no catch.\n3. One price, forever.']], t + 86400 * 45),
  ];
  openFile(new File([JSON.stringify(sample)], 'sample-conversations.json', { type: 'application/json' }));
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

updatePro();
license.refresh().then((r) => { updatePro(); if (r.notice) say(r.notice, 'warn'); });
