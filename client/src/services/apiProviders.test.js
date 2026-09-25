import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, socket } = vi.hoisted(() => {
  const listeners = new Map();
  return { request: vi.fn(), socket: {
    on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); },
    emit(event) { for (const fn of listeners.get(event) || []) fn(); },
    removeAllListeners() { listeners.clear(); },
  } };
});
vi.mock('./apiCore.js', () => ({ request }));
vi.mock('./socket.js', () => ({ default: socket }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));

let getProviders;
let updateProvider;
beforeEach(async () => {
  vi.resetModules();
  socket.removeAllListeners();
  request.mockReset();
  ({ getProviders, updateProvider } = await import('./apiProviders.js'));
});

describe('shared providers snapshot', () => {
  it('shares one read, isolates results, and refetches on event and reconnect', async () => {
    request.mockResolvedValue({ providers: [{ id: 'example' }] });
    const [first, second] = await Promise.all([getProviders(), getProviders()]);
    expect(request).toHaveBeenCalledTimes(1);
    first.providers[0].id = 'changed';
    expect(second.providers[0].id).toBe('example');
    expect((await getProviders()).providers[0].id).toBe('example');
    socket.emit('providers:changed');
    await getProviders();
    socket.emit('connect');
    await getProviders();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('detaches one aborted caller without cancelling another or the shared fetch', async () => {
    let resolve;
    request.mockImplementation(() => new Promise(done => { resolve = done; }));
    const controller = new AbortController();
    const aborted = getProviders({ signal: controller.signal, silent: true });
    const active = getProviders();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    resolve({ providers: [] });
    await expect(active).resolves.toEqual({ providers: [] });
    expect(request.mock.calls[0][1].signal).toBeUndefined();
  });

  it('forces a fresh read and invalidates after a successful mutation', async () => {
    request.mockResolvedValue({ providers: [] });
    await getProviders();
    await getProviders({ fresh: true });
    await updateProvider('example', { name: 'Example' });
    await getProviders();
    expect(request.mock.calls.filter(([path]) => path === '/providers')).toHaveLength(3);
  });
});
