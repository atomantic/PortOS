import { describe, expect, it, vi } from 'vitest';
import { listLoraAdapters, loraRequestField } from './llamaLoraAdapters.js';

const reply = (body, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

describe('listLoraAdapters', () => {
  it('reads the adapter route beside /v1 and names each adapter by its file', async () => {
    const fetchImpl = reply([{ id: 0, path: 'models/sub/example-lora-F16.gguf', scale: 0 }, { id: 1, path: 'C:\\models\\other.gguf', scale: 1 }]);
    expect(await listLoraAdapters('http://127.0.0.1:5568/v1/', { fetchImpl })).toEqual([
      { id: 0, name: 'example-lora-F16', path: 'models/sub/example-lora-F16.gguf' },
      { id: 1, name: 'other', path: 'C:\\models\\other.gguf' },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:5568/lora-adapters');
  });

  // An adapter is offered only when the server confirms it; every failure reads as "none loaded".
  it.each([
    ['no endpoint', null, reply([])],
    ['a server that is down', 'http://127.0.0.1:5568/v1', vi.fn(async () => { throw new TypeError('fetch failed'); })],
    ['a build without the route', 'http://127.0.0.1:5568/v1', reply('not found', 404)],
    ['a body that is not a list', 'http://127.0.0.1:5568/v1', reply({ error: 'x' })],
    ['a body that is not JSON', 'http://127.0.0.1:5568/v1', reply('<html>')],
  ])('returns no adapters for %s', async (_label, endpoint, fetchImpl) => {
    expect(await listLoraAdapters(endpoint, { fetchImpl })).toEqual([]);
  });

  it('drops entries without a usable id', async () => {
    expect(await listLoraAdapters('http://h/v1', { fetchImpl: reply([{ id: -1 }, { id: 'a' }, { path: 'x.gguf' }, { id: 2, path: 'y.gguf' }]) }))
      .toEqual([{ id: 2, name: 'y', path: 'y.gguf' }]);
  });
});

describe('loraRequestField', () => {
  const adapters = [{ id: 0 }, { id: 3 }];
  it('applies the chosen adapter at its scale and turns every other one off', () => {
    expect(loraRequestField(adapters, 3, 0.5)).toEqual([{ id: 0, scale: 0 }, { id: 3, scale: 0.5 }]);
  });
  it('turns every adapter off for the base model', () => {
    expect(loraRequestField(adapters, null, 1)).toEqual([{ id: 0, scale: 0 }, { id: 3, scale: 0 }]);
  });
});
