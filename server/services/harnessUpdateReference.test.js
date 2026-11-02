import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing } from './harnessUpdateReference.js';

const { createReader, nextPage, createService } = __testing;
const pkg = '@example/agent';
const current = '1.2.3';
const target = '1.2.4';
const id = 'GHSA-2345-6789-cfgh';
const record = {
  ghsa_id: id, cve_id: 'CVE-2026-12345', severity: 'medium', withdrawn_at: null,
  vulnerabilities: [{ package: { ecosystem: 'npm', name: pkg }, vulnerable_version_range: '< 1.2.4', first_patched_version: target }],
};
const packument = { name: pkg, 'dist-tags': { latest: target }, time: { [target]: '2026-01-01T00:00:00.000Z' },
  versions: { [target]: { name: pkg, version: target } } };

afterEach(() => vi.unstubAllGlobals());

describe('harness update reference', () => {
  it('uses the exact npm release timestamp and separately checks current and candidate advisories', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async url => {
      requests.push(String(url));
      if (String(url).startsWith('https://registry.npmjs.org/')) return Response.json(packument);
      const parsed = new URL(url);
      return Response.json(parsed.searchParams.get('affects') === `${pkg}@${current}` ? [record] : []);
    }));
    const result = await createReader()({ packageName: pkg, installedVersion: current, candidateVersion: target });
    expect(result.release).toEqual({ state: 'verified', publishedAt: '2026-01-01T00:00:00.000Z' });
    expect(result.installed).toMatchObject({ state: 'checked', items: [{ id, cve: 'CVE-2026-12345', severity: 'medium' }] });
    expect(result.candidate).toEqual({ state: 'checked', items: [] });
    expect(result.fixed).toEqual([id]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain(encodeURIComponent(pkg));
  });

  it('does not infer a fix from missing, partial, or changed evidence', async () => {
    const installed = { state: 'checked', items: [{ id, firstPatchedVersions: [target] }] };
    const candidate = { state: 'unknown', items: [] };
    const read = createReader({ readRegistry: vi.fn().mockResolvedValue({ state: 'verified' }),
      readAdvisories: vi.fn().mockResolvedValueOnce(installed).mockResolvedValueOnce(candidate) });
    expect((await read({ packageName: pkg, installedVersion: current, candidateVersion: target })).fixed).toEqual([]);
    const changed = createReader({ readRegistry: vi.fn().mockResolvedValue({ state: 'changed' }),
      readAdvisories: vi.fn().mockResolvedValueOnce(installed).mockResolvedValueOnce({ state: 'checked', items: [] }) });
    expect((await changed({ packageName: pkg, installedVersion: current, candidateVersion: target })).fixed).toEqual([]);
  });

  it('keeps rate limits and malformed advisory data distinct from an empty successful result', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).startsWith('https://registry.npmjs.org/')
      ? Response.json(packument) : new Response('', { status: 429 })));
    const result = await createReader()({ packageName: pkg, installedVersion: current, candidateVersion: target });
    expect(result.installed.state).toBe('unknown');
    expect(result.candidate.state).toBe('unknown');
    expect(result.fixed).toEqual([]);
  });

  it('rejects an advisory pagination link to a different origin or query', () => {
    const base = 'https://api.github.com/advisories?ecosystem=npm&type=reviewed&affects=agent%401.0.0&per_page=100';
    expect(() => nextPage('<https://example.com/advisories?page=2>; rel="next"', base)).toThrow();
    expect(() => nextPage('<https://api.github.com/advisories?ecosystem=npm&type=reviewed&affects=other%401.0.0&per_page=100&page=2>; rel="next"', base)).toThrow();
  });

  it('retains found advisories if a later page fails and marks the check incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).startsWith('https://registry.npmjs.org/')) return Response.json(packument);
      const parsed = new URL(url);
      if (parsed.searchParams.get('page') === '2') return new Response('', { status: 429 });
      if (parsed.searchParams.get('affects') !== `${pkg}@${current}`) return Response.json([]);
      parsed.searchParams.set('page', '2');
      return Response.json([record], { headers: { link: `<${parsed.href}>; rel="next"` } });
    }));
    const result = await createReader()({ packageName: pkg, installedVersion: current, candidateVersion: target });
    expect(result.installed).toMatchObject({ state: 'partial', items: [{ id }] });
    expect(result.fixed).toEqual([]);
  });

  it('treats a different public latest or a future timestamp as unverified', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).startsWith('https://registry.npmjs.org/')
      ? Response.json({ ...packument, 'dist-tags': { latest: '1.2.5' } }) : Response.json([])));
    const input = { packageName: pkg, installedVersion: current, candidateVersion: target };
    expect((await createReader()(input)).release.state).toBe('incomparable');
    fetch.mockImplementation(async url => String(url).startsWith('https://registry.npmjs.org/')
      ? Response.json({ ...packument, time: { [target]: '2999-01-01T00:00:00Z' } }) : Response.json([]));
    expect((await createReader()(input)).release.state).toBe('unknown');
  });
});

describe('review ticket', () => {
  const token = '00000000-0000-4000-8000-000000000001';
  const identity = { path: '/fixture/cli', target: '/fixture/cli', file: [1], link: [1] };
  const runtime = { id: 'example', command: 'example', npmPackage: pkg, selfUpdate: ['update'] };
  const row = () => ({ id: 'harness:example', revision: `${current}:${target}`, harnessUpdate: {
    id: 'example', package: pkg, installedVersion: current, candidateVersion: target, updatable: true,
  } });
  const setup = (overrides = {}) => createService({ runtimeFor: () => runtime, snapshot: () => ({ items: [row()] }),
    probe: async () => ({ version: current }), capture: async () => identity, read: async () => ({ state: 'unknown' }),
    now: () => 1000, token: () => token, ...overrides });

  it('binds a single-use, expiring ticket to the observed runtime and version', async () => {
    let time = 1000;
    const service = setup({ now: () => time });
    expect(await service.get('example')).toEqual({ state: 'unknown', ticket: token });
    expect(service.take('example', token, current, '1.2.5')).toBeNull();
    await service.get('example');
    const proof = service.take('example', token, current, target);
    expect(proof.identity).toEqual(identity);
    expect(service.take('example', token, current, target)).toBeNull();
    await service.get('example');
    time += 5 * 60 * 1000;
    expect(service.take('example', token, current, target)).toBeNull();
  });

  it('refuses an executable replacement or a ticket that expires during identity verification', async () => {
    let time = 1000;
    let actual = identity;
    const service = setup({ now: () => time, capture: async () => actual });
    await service.get('example');
    const proof = service.take('example', token, current, target);
    actual = { ...identity, file: [2] };
    expect(await service.matches(runtime, proof)).toBe(false);
    actual = identity;
    expect(await service.matches(runtime, proof)).toBe(true);
    const expiryService = setup({ now: () => time, capture: async () => { time = 301000; return identity; } });
    expect(await expiryService.matches(runtime, proof)).toBe(false);
  });

  it('does not issue a ticket if the row becomes unverified while metadata is loading', async () => {
    let release;
    let currentRow = row();
    const waiting = new Promise(resolve => { release = resolve; });
    const service = setup({ snapshot: () => ({ items: [currentRow] }), read: () => waiting });
    const pending = service.get('example');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    currentRow = { ...currentRow, unverified: true };
    release({ state: 'unknown' });
    expect(await pending).toEqual({ state: 'changed', ticket: null });
  });
});
