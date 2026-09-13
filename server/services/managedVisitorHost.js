import { ServerError } from '../lib/errorHandler.js';

// Settings win over the env var so the owner can set/rotate the credential from
// Settings > Credentials without restarting PortOS — same precedence and
// rationale as `resolveCivitaiKey` in services/loras.js. Resolved fresh on every
// call (getSettings reads its JSON file each time; cheap, and avoids a stale
// in-memory token surviving a rotation).
async function resolveVisitorToken() {
  const env = (process.env.PORTOS_EIDOVERSE_VISITOR_TOKEN || '').trim();
  const { getSettings } = await import('./settings.js');
  const settings = await getSettings();
  const fromSettings = (settings?.secrets?.eidoverse?.visitorToken || '').trim();
  return fromSettings || env || '';
}

/** Explicitly configured local host only; construction and disabled capability reads make no requests. */
export function createManagedVisitorHost({ token, fetchImpl = fetch, port = 8940 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServerError('Invalid managed visitor host port.', { status: 400 });
  // An explicitly passed `token` (including '' in tests) is honored verbatim and
  // resolved statically, exactly as before. Omitting it entirely resolves fresh
  // from settings/env on every call, so a credential rotation takes effect
  // immediately rather than only at the next process restart.
  const explicitToken = typeof token === 'string' ? token : undefined;
  const resolveToken = explicitToken !== undefined ? async () => explicitToken : resolveVisitorToken;
  async function request(path, body, deadlineMs) {
    const token = await resolveToken();
    const enabled = /^[a-f0-9]{64}$/.test(token);
    if (!enabled) throw new ServerError('Managed visitor host credential is not configured.', { status: 409 });
    if (path === '/admissions' && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now())) throw new ServerError('Invalid managed visitor admission deadline.', { status: 409 });
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/managed-visitors/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(deadlineMs === undefined ? {} : { 'X-Managed-Visitor-Deadline': String(deadlineMs) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new ServerError('Managed visitor host refused the operation.', { status: 409 });
    const reader = response.body?.getReader();
    if (!reader) throw new ServerError('Managed visitor host response is unavailable.', { status: 409 });
    const chunks = []; let bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new ServerError('Managed visitor host response exceeds its bound.', { status: 409 }); }
      chunks.push(Buffer.from(part.value));
    }
    return Promise.resolve(Buffer.concat(chunks).toString('utf8')).then(JSON.parse)
      .catch(() => { throw new ServerError('Managed visitor host returned invalid JSON.', { status: 409 }); });
  }
  return {
    capabilities: async () => {
      const token = await resolveToken();
      if (!/^[a-f0-9]{64}$/.test(token)) return null;
      return request('/version').then(value => value.capabilities, () => null);
    },
    admit: (body, { deadlineMs } = {}) => request('/admissions', body, deadlineMs),
    observe: (id, body) => request(`/sessions/${encodeURIComponent(id)}/observations`, body),
    leave: (id, body) => request(`/sessions/${encodeURIComponent(id)}/leave`, body),
    action: (id, body) => request(`/sessions/${encodeURIComponent(id)}/actions`, body),
  };
}
