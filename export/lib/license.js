// ThreadKeep Pro license check for the web tool. Same activate / validate / deactivate flow as the extension
// (src/background/license.ts), against the same license server. This is the only network call the page makes,
// and the page's Content-Security-Policy allows no other. The request carries the key and a device label,
// never anything from your chats.
export const LICENSE_API = 'https://license-live-production.up.railway.app';
export const STORAGE_KEY = 'threadkeep-export-license-v1';
export const RECHECK_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 12_000;

export const MSG = {
  empty: 'Paste your license key first.',
  notFound: 'That license key was not found. Check that you copied all of it.',
  inactive: 'This license key is no longer active (the subscription ended, or it was refunded or revoked).',
  limit: 'This key is already active on 3 devices, the most one license allows. Remove it on a device you no longer use, or contact support to reset it.',
  wrongProduct: 'That key is not for ThreadKeep Pro.',
  offline: 'Could not reach the ThreadKeep license check. Check your connection and try again.',
  other: 'This key could not be activated. Please try again, or contact support.',
  dropped: 'Your Pro license is no longer active, so bulk export is locked again.',
};

/** Codes that mean "this key or this activation is not valid". Anything else means "could not ask". */
const REJECTIONS = new Set(['not_found', 'inactive', 'wrong_product', 'rejected', 'invalid_request', 'instance_inactive']);

function parseTime(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function mask(key) { return `****-${key.slice(-4).toUpperCase()}`; }

export function createLicense({ fetchImpl = globalThis.fetch?.bind(globalThis), storage = null, now = () => Date.now(), api = LICENSE_API, label = 'browser' } = {}) {
  let rec = null;
  try { const raw = storage?.getItem(STORAGE_KEY); if (raw) rec = JSON.parse(raw); } catch { rec = null; }
  if (rec && (typeof rec.key !== 'string' || typeof rec.instanceId !== 'string')) rec = null;

  const save = () => {
    try { if (rec) storage?.setItem(STORAGE_KEY, JSON.stringify(rec)); else storage?.removeItem(STORAGE_KEY); } catch { /* storage blocked: the license lasts for this visit */ }
  };

  async function call(action, body) {
    try {
      const res = await fetchImpl(`${api}/v1/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      if (res.ok && json && typeof json === 'object') return { ok: true, body: json };
      return { ok: false, status: res.ok ? 502 : res.status, code: typeof json?.error === 'string' ? json.error : '' };
    } catch {
      return { ok: false, status: 0, code: '' };
    }
  }

  const valid = (body, t) => {
    const expiresAt = parseTime(body.license?.expires_at);
    const instanceOk = body.instance == null || body.instance.status === 'active';
    return { ok: body.license?.status === 'active' && instanceOk && (expiresAt === null || expiresAt > t), expiresAt };
  };

  const api_ = {
    /** True while the license is good: active at the last check, not expired, and checked within the grace window. */
    isPro() {
      if (!rec) return false;
      const t = now();
      if (rec.expiresAt != null && rec.expiresAt <= t) return false;
      return t - rec.checkedAt < OFFLINE_GRACE_MS;
    },
    info() { return rec ? { displayKey: mask(rec.key), expiresAt: rec.expiresAt ?? null } : null; },

    /** Activates a pasted key on this browser. Throws an Error with a message fit to show. */
    async activate(raw) {
      const key = String(raw ?? '').trim();
      if (!key) throw new Error(MSG.empty);
      const r = await call('activate', { key, instance_name: label.slice(0, 100).replace(/[<>\u0000-\u001f\u007f]/g, '') });
      if (!r.ok) {
        switch (r.code) {
          case 'not_found': case 'invalid_request': case 'rejected': throw new Error(MSG.notFound);
          case 'activation_limit': throw new Error(MSG.limit);
          case 'inactive': throw new Error(MSG.inactive);
          case 'wrong_product': throw new Error(MSG.wrongProduct);
          default:
            if (r.status === 0 || r.status >= 500 || r.status === 429 || r.code === 'origin_not_allowed') throw new Error(MSG.offline);
            throw new Error(MSG.other);
        }
      }
      const t = now();
      const instanceId = typeof r.body.instance?.id === 'string' ? r.body.instance.id : '';
      if (!instanceId) throw new Error(MSG.other);
      const v = valid(r.body, t);
      if (!v.ok) {
        await call('deactivate', { key, instance_id: instanceId });
        throw new Error(MSG.inactive);
      }
      const previous = rec;
      rec = { key, instanceId, checkedAt: t, expiresAt: v.expiresAt };
      save();
      if (previous && previous.key !== key) await call('deactivate', { key: previous.key, instance_id: previous.instanceId });
      return api_.info();
    },

    /**
     * Re-checks a stored license when the last good check is older than 24 h (or `force`).
     * Returns { pro, notice? }. A refused key drops to free; an unreachable server keeps Pro for 7 days.
     */
    async refresh(force = false) {
      if (!rec) return { pro: false };
      const t = now();
      if (!force && t - rec.checkedAt < RECHECK_MS && (rec.expiresAt == null || rec.expiresAt > t)) return { pro: api_.isPro() };
      const r = await call('validate', { key: rec.key, instance_id: rec.instanceId });
      if (r.ok) {
        const v = valid(r.body, t);
        if (v.ok) { rec = { ...rec, checkedAt: t, expiresAt: v.expiresAt }; save(); return { pro: true }; }
        rec = null; save();
        return { pro: false, notice: MSG.dropped };
      }
      if (REJECTIONS.has(r.code)) { rec = null; save(); return { pro: false, notice: MSG.dropped }; }
      return { pro: api_.isPro() }; // could not ask: grace window applies
    },

    /** Frees this browser's device slot (best effort) and goes back to free. */
    async remove() {
      const cur = rec;
      rec = null;
      save();
      if (cur) await call('deactivate', { key: cur.key, instance_id: cur.instanceId });
    },
  };
  return api_;
}
