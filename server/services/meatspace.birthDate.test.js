import { describe, it, expect, vi, beforeEach } from 'vitest';

// getBirthDateStrict (#2757) reports whether the meatspace config read was TRUSTWORTHY, so the
// character CTA can say "fix your birth date" for a corrupt/unreadable config vs "set your birth
// date" for a genuinely unset one. This suite drives the file layer through a mock so the
// readable-vs-unreadable classification is exercised without touching disk. meatspace.test.js
// deliberately inlines pure functions to avoid mocking; this file isolates the one I/O function.

const store = vi.hoisted(() => ({ ok: true, value: null }));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-test-data', meatspace: '/tmp/portos-test-data/meatspace', digitalTwin: '/tmp/portos-test-data/digital-twin' },
  atomicWrite: vi.fn(async () => {}),
  ensureDir: vi.fn(async () => {}),
  readJSONFile: vi.fn(async () => ({})),
  // The strict reader returns { ok, value } — ok:false is a corrupt/unreadable file, ok:true a
  // clean parse (whose ROOT SHAPE getBirthDateStrict must still validate).
  readJSONFileStrict: vi.fn(async () => ({ ok: store.ok, value: store.value })),
}));
vi.mock('./genome.js', () => ({ getSnpIndex: vi.fn(async () => ({})) }));
vi.mock('./mortalLoomStore.js', () => ({
  mlGetProfileIfEnabled: vi.fn(async () => null),
  mlPatchProfileIfEnabled: vi.fn(async () => {}),
}));
vi.mock('fs/promises', () => ({ readFile: vi.fn(async () => '{}') }));

const meatspace = await import('./meatspace.js');

describe('getBirthDateStrict (#2757)', () => {
  beforeEach(() => { store.ok = true; store.value = { birthDate: null }; });

  it('is readable with the date for a clean object config', async () => {
    store.value = { birthDate: '1984-01-01' };
    expect(await meatspace.getBirthDateStrict()).toEqual({ birthDate: '1984-01-01', readable: true });
  });

  it('is readable+unset for a clean object config with no birthDate', async () => {
    store.value = {};
    expect(await meatspace.getBirthDateStrict()).toEqual({ birthDate: undefined, readable: true });
  });

  it('is UNREADABLE when the strict read failed (corrupt/unparseable file)', async () => {
    store.ok = false; store.value = null;
    expect(await meatspace.getBirthDateStrict()).toEqual({ birthDate: null, readable: false });
  });

  it('is UNREADABLE for a parseable-but-non-object root (array / string / number) — codex review', async () => {
    for (const bad of [[], 'corrupt', 42, null]) {
      store.ok = true; store.value = bad;
      // A non-object root is a corrupt config, not a trustworthy "unset" — must read as unreadable
      // so the CTA prompts "fix", never the friendly "set".
      expect(await meatspace.getBirthDateStrict()).toEqual({ birthDate: null, readable: false });
    }
  });
});
