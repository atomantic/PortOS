import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, createContext, runInContext } from 'node:vm';
import { bindAuthoredPreviewPlayback, readAuthoredPreviewDeclaration } from './authoredPreviewPlayback.js';
import { AUTHORED_PREVIEW_HANDSHAKE_MS, AUTHORED_PREVIEW_PLAYBACK_TARGET } from '../../lib/generatedPreviewPlaybackSchema.js';

const roots = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function document(text) {
  const root = await mkdtemp(join(tmpdir(), 'authored-preview-contract-'));
  roots.push(root);
  if (text !== undefined) await writeFile(join(root, 'preview-playback.json'), text);
  return root;
}
const declared = JSON.stringify({ version: 1, contract: 'portos-complete-frame-v1' });
const implementation = `
  globalThis.originalApi = {
    version: 1, fps: 30, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1',
    clock() { return this === originalApi ? 123 : -1; },
    prepare(value) { return { status: 'prepared', epoch: value.epoch, receiver: this === originalApi }; },
    play() {}, sync() {}, pause() {}, dispose() {},
  };
  globalThis.portosComposition = { previewPlayback: originalApi };
`;
function browser(source = implementation) {
  // A non-contextified VM global preserves browser-style throwing accessors.
  const context = createContext(constants.DONT_CONTEXTIFY);
  const evaluate = expression => runInContext(expression, context, { timeout: 50 });
  evaluate(source);
  return { context, evaluate, page: { evaluate: vi.fn(evaluate) } };
}
const target = JSON.stringify(AUTHORED_PREVIEW_PLAYBACK_TARGET);

describe('explicit authored preview declaration', () => {
  it('distinguishes absent opt-in and never manufactures a declaration', async () => {
    const root = await document();
    await writeFile(join(root, 'engine.js'), '/* existing arbitrary async document */');
    expect(await readAuthoredPreviewDeclaration(root)).toEqual({ declared: false, supported: false, reason: 'absent' });
    expect(await readFile(join(root, 'engine.js'), 'utf8')).toBe('/* existing arbitrary async document */');
  });

  it.each(['{', 'null', '[]', 'true', '{}', '{"version":1}', '{"version":"1","contract":"portos-complete-frame-v1"}', '{"version":1,"contract":"portos-complete-frame-v1","extra":true}', ' '.repeat(1025)])(
    'declines malformed declaration %j', async text => {
      expect(await readAuthoredPreviewDeclaration(await document(text))).toEqual({ declared: true, supported: false, reason: 'invalid-declaration' });
    },
  );

  it.each([{ version: 2, contract: 'portos-complete-frame-v1' }, { version: 1, contract: 'unknown' }])(
    'declines unsupported declaration %j without modifying it', async value => {
      const text = JSON.stringify(value), root = await document(text);
      expect(await readAuthoredPreviewDeclaration(root)).toMatchObject({ declared: true, supported: false, reason: 'unsupported-declaration' });
      expect(await readFile(join(root, 'preview-playback.json'), 'utf8')).toBe(text);
    },
  );

  it('declines symlinks without treating even a dangling link as an absent declaration', async () => {
    const root = await document();
    await symlink(join(root, 'absent-target.json'), join(root, 'preview-playback.json'));
    expect(await readAuthoredPreviewDeclaration(root)).toEqual({ declared: true, supported: false, reason: 'invalid-declaration' });
  });

  it('admits only the declared contract with trusted finite staged video cadence above 10', async () => {
    const root = await document(declared);
    for (const fps of [undefined, null, NaN, Infinity, 0, 10]) {
      expect(await readAuthoredPreviewDeclaration(root, { scenes: [{ media: { kind: 'video', fps } }] }))
        .toMatchObject({ declared: true, supported: false, reason: 'unsupported-video-fps' });
    }
    for (const fps of [10.01, 24, 30, 60]) {
      expect(await readAuthoredPreviewDeclaration(root, { scenes: [{ media: { kind: 'video', fps } }, { media: { kind: 'image' } }, {}] }))
        .toEqual({ declared: true, supported: true, version: 1, contract: 'portos-complete-frame-v1' });
    }
    expect(await readAuthoredPreviewDeclaration(root)).toMatchObject({ supported: true });
    expect(await readFile(join(root, 'preview-playback.json'), 'utf8')).toBe(declared);
  });
});

describe('owned authored runtime handshake', () => {
  it('snapshots methods and their receiver once behind an immutable bridge, preserving host root accessors', async () => {
    const runtime = browser(`${implementation}
      const composition = portosComposition; globalThis.rootReads = 0;
      Object.defineProperty(globalThis, 'portosComposition', { get() { rootReads++; return composition; } });
    `);
    expect(await bindAuthoredPreviewPlayback(runtime.page)).toEqual({ supported: true, version: 1, fps: 30,
      presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1', target: AUTHORED_PREVIEW_PLAYBACK_TARGET });
    runtime.evaluate(`
      originalApi.clock = () => 999;
      originalApi.prepare = () => { throw Error('replacement must not run'); };
      composition.previewPlayback = { clock: () => 888 };
      globalThis.other = { clock: globalThis[${target}].clock };
    `);
    expect(runtime.evaluate(`globalThis[${target}].clock()`)).toBe(123);
    expect(runtime.evaluate('other.clock()')).toBe(123);
    expect(runtime.evaluate(`globalThis[${target}].prepare({epoch:7})`)).toMatchObject({ status: 'prepared', epoch: 7, receiver: true });
    expect(runtime.evaluate('rootReads')).toBe(1);
    expect(runtime.evaluate(`Object.isFrozen(globalThis[${target}])`)).toBe(true);
    expect(runtime.evaluate(`Object.getOwnPropertyDescriptor(globalThis, ${target})`)).toMatchObject({ writable: false, configurable: false });
    expect(runtime.evaluate(`Reflect.set(globalThis, ${target}, {})`)).toBe(false);
    expect(runtime.evaluate(`Reflect.deleteProperty(globalThis, ${target})`)).toBe(false);
  });

  it.each([
    'delete globalThis.portosComposition', 'portosComposition.previewPlayback = null',
    'originalApi.version = 2', 'originalApi.fps = 24', 'originalApi.presentation = "partial"',
    'originalApi.mediaTiming = "raw"', 'delete originalApi.dispose',
    'Object.setPrototypeOf(originalApi, { dispose() {} }); delete originalApi.dispose',
    'originalApi.clock = 1',
  ])('declines unsupported ordinary runtime shape: %s', async change => {
    const runtime = browser(`${implementation}\n${change}`);
    expect(await bindAuthoredPreviewPlayback(runtime.page)).toEqual({ supported: false, reason: 'unsupported-runtime' });
    expect(runtime.evaluate(`Object.hasOwn(globalThis, ${target})`)).toBe(false);
  });

  it.each(['version', 'prepare'])('does not execute authored API getter %s', async name => {
    const runtime = browser(`${implementation}
      globalThis.reads = 0;
      Object.defineProperty(originalApi, ${JSON.stringify(name)}, { get() { reads++; throw Error('getter ran'); } });
    `);
    expect(await bindAuthoredPreviewPlayback(runtime.page)).toMatchObject({ supported: false });
    expect(runtime.evaluate('reads')).toBe(0);
  });

  it('does not execute an authored previewPlayback getter or overwrite an existing bridge', async () => {
    const getter = browser(`${implementation}
      Object.defineProperty(portosComposition, 'previewPlayback', { get() { throw Error('getter ran'); } });
    `);
    expect(await bindAuthoredPreviewPlayback(getter.page)).toMatchObject({ supported: false, reason: 'unsupported-runtime' });
    const occupied = browser(`${implementation}
      Object.defineProperty(globalThis, ${target}, { get() { throw Error('existing bridge getter ran'); } });
    `);
    expect(await bindAuthoredPreviewPlayback(occupied.page)).toEqual({ supported: false, reason: 'occupied-bridge' });
  });

  it('propagates root/Proxy inspection failures instead of falling back on an uncertain page', async () => {
    for (const source of [
      `Object.defineProperty(globalThis, 'portosComposition', { get() { throw Error('root inspection failed'); } });`,
      `${implementation} portosComposition.previewPlayback = new Proxy(originalApi, { getOwnPropertyDescriptor() { throw Error('proxy inspection failed'); } });`,
    ]) {
      await expect(bindAuthoredPreviewPlayback(browser(source).page)).rejects.toThrow('inspection failed');
    }
  });

  it('propagates actual VM interruption of stuck synchronous Proxy inspection', async () => {
    const runtime = browser(`${implementation}
      portosComposition.previewPlayback = new Proxy(originalApi, { getOwnPropertyDescriptor() { while (true) {} } });
    `);
    await expect(bindAuthoredPreviewPlayback(runtime.page)).rejects.toThrow('Script execution timed out');
  });

  it('bounds unsettled page inspection and owns late rejection without declaring fallback', async () => {
    vi.useFakeTimers();
    let fail;
    const promise = bindAuthoredPreviewPlayback({ evaluate: () => new Promise((_resolve, reject) => { fail = reject; }) });
    const verdict = expect(promise).rejects.toMatchObject({ code: 'AUTHORED_PREVIEW_HANDSHAKE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(AUTHORED_PREVIEW_HANDSHAKE_MS);
    await verdict;
    fail(new Error('late owned CDP rejection'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid CDP receipts and late resolution even when the timer has not run', async () => {
    await expect(bindAuthoredPreviewPlayback({ evaluate: () => ({ supported: true }) }))
      .rejects.toMatchObject({ code: 'AUTHORED_PREVIEW_HANDSHAKE_INVALID' });
    vi.useFakeTimers();
    const runtime = browser();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(AUTHORED_PREVIEW_HANDSHAKE_MS);
    const promise = bindAuthoredPreviewPlayback(runtime.page);
    await expect(promise).rejects.toMatchObject({ code: 'AUTHORED_PREVIEW_HANDSHAKE_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns an uncertain receipt inspection throw as well as evaluation rejection', async () => {
    const receipt = Object.defineProperty({}, 'supported', { get() { throw Error('receipt inspection failed'); } });
    await expect(bindAuthoredPreviewPlayback({ evaluate: () => receipt })).rejects.toThrow('receipt inspection failed');
  });
});
