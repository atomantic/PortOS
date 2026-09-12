import { ServerError } from '../lib/errorHandler.js';

/** Explicitly configured local host only; construction and disabled capability reads make no requests. */
export function createManagedVisitorHost({ token = process.env.PORTOS_EIDOVERSE_VISITOR_TOKEN, fetchImpl = fetch, port = 8940 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServerError('Invalid managed visitor host port.', { status: 400 });
  const enabled = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
  async function request(path, body) {
    if (!enabled) throw new ServerError('Managed visitor host credential is not configured.', { status: 409 });
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/managed-visitors/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    capabilities: () => enabled ? request('/version').then(value => value.capabilities, () => null) : Promise.resolve(null),
    admit: body => request('/admissions', body),
    observe: (id, body) => request(`/sessions/${encodeURIComponent(id)}/observations`, body),
    leave: (id, body) => request(`/sessions/${encodeURIComponent(id)}/leave`, body),
    action: (id, body) => request(`/sessions/${encodeURIComponent(id)}/actions`, body),
  };
}
