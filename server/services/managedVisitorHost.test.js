import { expect, it, vi } from 'vitest';
import { createManagedVisitorHost } from './managedVisitorHost.js';
it('disabled transport makes no requests and explicit configuration keeps host credentials on the fixed loopback namespace', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ capabilities: { managedVisitors: null } })));
  const disabled = createManagedVisitorHost({ token: '', fetchImpl });
  expect(await disabled.capabilities()).toBe(null); await expect(disabled.admit({})).rejects.toThrow(/not configured/);
  expect(fetchImpl).not.toHaveBeenCalled();
  const token = 'a'.repeat(64), host = createManagedVisitorHost({ token, fetchImpl }); await host.capabilities();
  const [url, options] = fetchImpl.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:8940/api/managed-visitors/v1/version');
  expect(options.headers.Authorization).toBe(`Bearer ${token}`); expect(options.redirect).toBe('error'); expect(options.signal).toBeInstanceOf(AbortSignal);
});
it('host response buffering is bounded and malformed/non-success replies do not become capabilities', async () => {
  let canceled = false;
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(17000)); }, cancel() { canceled = true; } })));
  const host = createManagedVisitorHost({ token: 'a'.repeat(64), fetchImpl });
  await expect(host.observe('session', {})).rejects.toThrow(/bound/); expect(canceled).toBe(true);
  fetchImpl.mockResolvedValueOnce(new Response('not json')); expect(await host.capabilities()).toBe(null);
  fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 401 })); await expect(host.admit({})).rejects.toThrow(/refused/);
});
