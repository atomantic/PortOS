import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../lib/ports.js', () => ({ PORTS: { TAILCAT_INGRESS: 0 } }));
import { configureTailcatIngress, createTailcatIngressServer, ensureTailcatIngress, stopTailcatIngress } from './tailcatIngress.js';
import { isRemoteRequest } from '../lib/requestOrigin.js';

afterEach(() => stopTailcatIngress());

it('refuses a plaintext fallback when the main API is using HTTPS', () => {
  expect(() => createTailcatIngressServer(() => {}, { httpsEnabled: true }))
    .toThrow('Tailcat ingress requires the active API TLS certificate');
  const plain = createTailcatIngressServer(() => {}, { httpsEnabled: false });
  expect(plain.httpsEnabled).toBe(false);
  expect(plain.mirror).toBe(null);
});

it('binds one loopback listener on demand and marks requests independently of headers', async () => {
  const io = { attach: vi.fn() };
  configureTailcatIngress({ app: (req, res) => res.end(JSON.stringify({ remote: isRemoteRequest(req) })), io });
  expect(io.attach).not.toHaveBeenCalled();
  await Promise.all([ensureTailcatIngress(), ensureTailcatIngress()]);
  expect(io.attach).toHaveBeenCalledTimes(1);
  const server = io.attach.mock.calls[0][0];
  expect(server.address().address).toBe('127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'X-PortOS-Local': 'true' } });
  expect(await response.json()).toEqual({ remote: true });
  await ensureTailcatIngress();
  expect(io.attach).toHaveBeenCalledTimes(1);
});
