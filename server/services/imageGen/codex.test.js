import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// Each test runs against a synthetic ~/.codex layout so it never touches
// the user's real generated_images dir. We mock os.homedir() directly —
// node's homedir() uses getpwuid() on macOS and ignores $HOME, so just
// setting the env var isn't enough.
const TEST_HOME = join(tmpdir(), `portos-codex-test-${process.pid}-${Date.now()}`);
vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return { ...actual, homedir: () => TEST_HOME };
});

// Spawn mock — capture every spawn call so tests can assert args, drive
// stdout/stderr lines, and trigger the close event whenever they want.
const spawnCalls = [];
const makeFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
};
// Partial mock — keep execFile/exec real for fileUtils.dirSize and friends,
// only swap spawn so we can assert + drive the codex child.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((bin, args) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, child });
      return child;
    }),
  };
});

// Stable PATHS.images under the fake HOME so the harvest's copyFile lands
// in a predictable place we can read back.
const FAKE_IMAGES_DIR = join(TEST_HOME, 'data-images');
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  // Mutate the actual PATHS object so functions inside fileUtils.js
  // (e.g. resolveGalleryImage) see the test images dir at call time —
  // a spread-only override would leave the original PATHS.images intact
  // for any function closing over the actual module's binding.
  actual.PATHS.images = FAKE_IMAGES_DIR;
  return {
    ...actual,
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

// imageGenEvents is fine to import for real, but we don't want stray
// listeners between tests. Reset its emitter state in beforeEach.
const codex = await import('./codex.js');
const { imageGenEvents } = await import('../imageGenEvents.js');

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  spawnCalls.length = 0;
  imageGenEvents.removeAllListeners();
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('codex provider — generateImage', () => {
  it('spawns codex exec with $imagegen prompt prefix and the configured model', async () => {
    const p = codex.generateImage({ prompt: 'a small fox', model: 'gpt-5.4' });
    // generateImage resolves immediately (fire-and-forget run); resolved
    // value is the job descriptor.
    const job = await p;
    expect(job.mode).toBe('codex');
    expect(job.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(spawnCalls.length).toBe(1);
    const { bin, args } = spawnCalls[0];
    expect(bin).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    // Codex's startup update check is disabled so image-gen never stalls on it.
    expect(args).toEqual(expect.arrayContaining(['-c', 'check_for_update_on_startup=false']));
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.4');
    // The prompt must be prefixed with `$imagegen ` so codex's bundled
    // imagegen skill triggers the built-in image_gen tool.
    const promptArg = args[args.length - 1];
    expect(promptArg.startsWith('$imagegen ')).toBe(true);
    expect(promptArg).toContain('a small fox');

    // Cleanup: end the spawned child so the tracking state resets.
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('appends a "(high quality)" hint when width or height ≥ 1536', async () => {
    await codex.generateImage({ prompt: 'a fox', width: 1536, height: 1024 });
    const promptArg = spawnCalls[0].args[spawnCalls[0].args.length - 1];
    expect(promptArg).toContain('(1536x1024)');
    expect(promptArg).toContain('(high quality)');
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('does not append "(high quality)" for sub-1536 dimensions', async () => {
    await codex.generateImage({ prompt: 'a fox', width: 1024, height: 1024 });
    const promptArg = spawnCalls[0].args[spawnCalls[0].args.length - 1];
    expect(promptArg).toContain('(1024x1024)');
    expect(promptArg).not.toContain('high quality');
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('honors codexPath override (custom binary)', async () => {
    await codex.generateImage({ prompt: 'a fox', codexPath: '/opt/custom/codex' });
    expect(spawnCalls[0].bin).toBe('/opt/custom/codex');
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('rejects when prompt is empty and there is no init image', async () => {
    await expect(codex.generateImage({ prompt: '   ' })).rejects.toThrow(/Prompt is required/);
  });

  it('allows an empty prompt when editing an init image', async () => {
    // resolveGalleryImage requires the file to exist under PATHS.images.
    await mkdir(FAKE_IMAGES_DIR, { recursive: true });
    await writeFile(join(FAKE_IMAGES_DIR, 'editme.png'), 'fake');
    await codex.generateImage({ prompt: '', initImagePath: 'editme.png', initImageStrength: 0.2 });
    const { args } = spawnCalls[0];
    expect(args.indexOf('-i')).toBeGreaterThan(-1);
    // Edit-prefix still drives the render even with no text target.
    expect(args[args.length - 1]).toMatch(/edit the attached reference image/i);
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('forwards initImagePath via `-i <FILE>` and reshapes the prompt for image-edit', async () => {
    // resolveGalleryImage requires the file to exist under PATHS.images.
    await mkdir(FAKE_IMAGES_DIR, { recursive: true });
    await writeFile(join(FAKE_IMAGES_DIR, 'proof.png'), 'fake');
    await codex.generateImage({
      prompt: 'cover art',
      width: 1024, height: 1536,
      initImagePath: 'proof.png',
      initImageStrength: 0.2,
    });
    const { args } = spawnCalls[0];
    const iIdx = args.indexOf('-i');
    expect(iIdx).toBeGreaterThan(-1);
    expect(args[iIdx + 1]).toBe(join(FAKE_IMAGES_DIR, 'proof.png'));
    // `-i` is VARIADIC in codex exec — without a `--` terminator it swallows the
    // prompt as a second image file ("No prompt provided"). Assert `--` follows
    // the options and the prompt is the positional AFTER it.
    const dashIdx = args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(iIdx);
    expect(dashIdx).toBe(args.length - 2);
    const promptArg = args[args.length - 1];
    // The `$imagegen` prefix is preserved so the bundled skill still triggers.
    expect(promptArg.startsWith('$imagegen ')).toBe(true);
    // Edit-prefix tells codex to use the attachment rather than redraw.
    expect(promptArg).toMatch(/edit the attached reference image/i);
    // Low strength → composition-preserving fidelity phrase.
    expect(promptArg).toMatch(/preserve composition/i);
    expect(promptArg).toContain('cover art');
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('drops initImagePath that escapes the gallery (defense-in-depth)', async () => {
    await codex.generateImage({
      prompt: 'cover art',
      // Absolute outside-gallery path — resolveGalleryImage rejects via basename.
      initImagePath: '/etc/passwd',
      initImageStrength: 0.2,
    });
    const { args } = spawnCalls[0];
    expect(args).not.toContain('-i');
    // No init image → no variadic to terminate, so no `--` is added.
    expect(args).not.toContain('--');
    const promptArg = args[args.length - 1];
    // No edit prefix when the init image is dropped.
    expect(promptArg).not.toMatch(/edit the attached reference image/i);
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('omits `-i` and the edit-prefix when no initImagePath is passed', async () => {
    await codex.generateImage({ prompt: 'cover art', width: 1024, height: 1024 });
    const { args } = spawnCalls[0];
    expect(args).not.toContain('-i');
    const promptArg = args[args.length - 1];
    expect(promptArg).not.toMatch(/edit the attached reference image/i);
    spawnCalls[0].child.exitCode = 1;
    spawnCalls[0].child.emit('close', 1, null);
    await flush();
  });

  it('allows concurrent generations (parallel codex lane)', async () => {
    const a = await codex.generateImage({ prompt: 'one' });
    const b = await codex.generateImage({ prompt: 'two' });
    expect(a.jobId).not.toBe(b.jobId);
    expect(spawnCalls.length).toBe(2);
    for (const c of spawnCalls) {
      c.child.exitCode = 1;
      c.child.emit('close', 1, null);
    }
    await flush();
  });
});

describe('codex provider — image harvest', () => {
  it('copies the latest ig_*.png from ~/.codex/generated_images/<session-id>/ into PATHS.images', async () => {
    const sessionId = '019dd59e-a8da-7bd2-a7d8-4ac6f46e7b07';
    const codexDir = join(TEST_HOME, '.codex', 'generated_images', sessionId);
    await mkdir(codexDir, { recursive: true });
    const fakePngBytes = Buffer.from('fakepngbytes');
    await writeFile(join(codexDir, 'ig_first.png'), fakePngBytes);

    const completedListener = vi.fn();
    imageGenEvents.on('completed', completedListener);

    const job = await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;

    // Drive the session id banner on stderr (codex prints it there).
    child.stderr.emit('data', Buffer.from(`session id: ${sessionId}\n`));
    // Then close cleanly.
    child.exitCode = 0;
    child.emit('close', 0, null);

    // Poll until the completed event fires (the harvest is async).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && completedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(completedListener).toHaveBeenCalledTimes(1);
    const finalPath = join(FAKE_IMAGES_DIR, job.filename);
    expect(existsSync(finalPath)).toBe(true);
    const written = await readFile(finalPath);
    expect(Buffer.compare(written, fakePngBytes)).toBe(0);

    // Sidecar metadata exists too.
    const sidecar = join(FAKE_IMAGES_DIR, `${job.generationId}.metadata.json`);
    expect(existsSync(sidecar)).toBe(true);
  });

  it('decodes image bytes from the Codex session JSONL when no generated_images file exists', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const sessionsDir = join(TEST_HOME, '.codex', 'sessions', '2026', '06', '22');
    await mkdir(sessionsDir, { recursive: true });
    const fakePngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);
    await writeFile(
      join(sessionsDir, `rollout-2026-06-22T00-19-45-${sessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-06-22T00:22:57.040Z',
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'ig_test',
          status: 'generating',
          result: fakePngBytes.toString('base64'),
        },
      })}\n`,
    );

    const completedListener = vi.fn();
    imageGenEvents.on('completed', completedListener);

    const job = await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    child.stderr.emit('data', Buffer.from(`session id: ${sessionId}\n`));
    child.exitCode = 0;
    child.emit('close', 0, null);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && completedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(completedListener).toHaveBeenCalledTimes(1);
    const finalPath = join(FAKE_IMAGES_DIR, job.filename);
    expect(existsSync(finalPath)).toBe(true);
    const written = await readFile(finalPath);
    expect(Buffer.compare(written, fakePngBytes)).toBe(0);
  });

  it('emits a failed event when codex exits 0 but writes no image (likely auth/quota issue)', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000000';
    // Create the session dir so the harvest path exists, but leave it
    // empty — that's the failure mode we surface to users.
    await mkdir(join(TEST_HOME, '.codex', 'generated_images', sessionId), { recursive: true });

    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    child.stderr.emit('data', Buffer.from(`session id: ${sessionId}\n`));
    child.exitCode = 0;
    child.emit('close', 0, null);

    // Wait out the harvest poll window (5s) plus a buffer.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && failedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failedListener).toHaveBeenCalledTimes(1);
    expect(failedListener.mock.calls[0][0].error).toMatch(/no image|account may not allow/i);
  }, 10000);

  it('captures the session id even when banner + long prompt echo arrive in a single >4KB stderr chunk', async () => {
    // Regression: with multi-KB comic-pipeline prompts, codex flushes the
    // entire banner *and* the echoed prompt in one stderr write. The old
    // captureSession() sliced the buffer to its tail before running the
    // regex, chopping the `session id:` line off the front and producing
    // a spurious "Codex returned no session id" failure even though the
    // banner was emitted correctly.
    const sessionId = '019e2513-c506-7de1-815e-c1f589229242';
    const codexDir = join(TEST_HOME, '.codex', 'generated_images', sessionId);
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'ig_x.png'), Buffer.from('png'));

    const completedListener = vi.fn();
    imageGenEvents.on('completed', completedListener);

    await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;

    const longPromptEcho = 'panel description '.repeat(400); // ~7KB
    const banner =
      'Reading additional input from stdin...\n' +
      'OpenAI Codex v0.130.0\n' +
      '--------\n' +
      'workdir: /tmp\n' +
      'model: gpt-5.5\n' +
      'provider: openai\n' +
      'approval: never\n' +
      'sandbox: workspace-write\n' +
      'reasoning effort: high\n' +
      'reasoning summaries: none\n' +
      `session id: ${sessionId}\n` +
      '--------\n' +
      'user\n' +
      `$imagegen ${longPromptEcho}\n`;
    expect(banner.length).toBeGreaterThan(4 * 1024);
    child.stderr.emit('data', Buffer.from(banner));
    child.exitCode = 0;
    child.emit('close', 0, null);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && completedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(completedListener).toHaveBeenCalledTimes(1);
  });

  it('captures the session id when a stdout chunk interleaves the stderr banner', async () => {
    // Regression: the old code fed both stdout and stderr into the same
    // bannerBuf. A stdout chunk arriving between two stderr chunks of the
    // banner would split the `session id:` line with unrelated text and
    // break the regex match.
    const sessionId = '019e2513-aaaa-7bcd-bb00-c1f589229242';
    const codexDir = join(TEST_HOME, '.codex', 'generated_images', sessionId);
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'ig_y.png'), Buffer.from('png'));

    const completedListener = vi.fn();
    imageGenEvents.on('completed', completedListener);

    await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;

    child.stderr.emit('data', Buffer.from('session id: 019e2513-aaaa-7bcd-'));
    child.stdout.emit('data', Buffer.from('progress noise\n'));
    child.stderr.emit('data', Buffer.from('bb00-c1f589229242\n'));
    child.exitCode = 0;
    child.emit('close', 0, null);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && completedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(completedListener).toHaveBeenCalledTimes(1);
  });

  it('emits a failed event when no session id banner is parsed', async () => {
    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    // Stdout/stderr deliberately empty — nothing to match SESSION_ID_RE.
    child.exitCode = 0;
    child.emit('close', 0, null);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(failedListener).toHaveBeenCalledTimes(1);
    expect(failedListener.mock.calls[0][0].error).toMatch(/no session id/i);
  });

  it('recovers from a spawn error so subsequent generations can run', async () => {
    // Simulate ENOENT (codex binary not found) by emitting 'error' on the
    // child. Without the activeProcess-clear fix, the next generateImage
    // call would forever throw 409 IMAGE_GEN_BUSY because activeProcess
    // would still be set to the dead child.
    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await codex.generateImage({ prompt: 'first', codexPath: '/nonexistent/codex' });
    const child = spawnCalls[0].child;
    child.emit('error', Object.assign(new Error('spawn /nonexistent/codex ENOENT'), { code: 'ENOENT' }));
    // The 'close' event also fires for spawn errors; emit it so the
    // idempotence guard is exercised.
    child.exitCode = 1;
    child.emit('close', 1, null);
    await flush();
    await new Promise((r) => setTimeout(r, 50));

    expect(failedListener).toHaveBeenCalled();
    // Critical: activeProcess must be cleared so a follow-up call works.
    const second = await codex.generateImage({ prompt: 'second' });
    expect(second.mode).toBe('codex');
    expect(spawnCalls.length).toBe(2);
    spawnCalls[1].child.exitCode = 1;
    spawnCalls[1].child.emit('close', 1, null);
    await flush();
  });

  // Simulate copyFile throwing — happens in the wild when data/images is
  // read-only, the disk is full, or the harvested PNG is unreadable.
  // Without the try/catch in the close handler, the async EventEmitter
  // listener would surface an unhandled rejection and leave the job stuck
  // in 'running'.
  // Skip on Windows: POSIX read-only chmod doesn't reliably block writes
  // there, and ESM `vi.spyOn(fs/promises, 'copyFile')` errors with
  // "Cannot redefine property: copyFile" because module namespaces aren't
  // configurable in ESM. macOS/Linux are the platforms PortOS actually
  // runs on; this regression-locks the fix where it matters.
  const itPosix = process.platform === 'win32' ? it.skip : it;
  itPosix('routes async errors in the close handler through finalizeError (no unhandled rejections)', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const codexDir = join(TEST_HOME, '.codex', 'generated_images', sessionId);
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'ig_a.png'), Buffer.from('x'));
    await mkdir(FAKE_IMAGES_DIR, { recursive: true });

    const { chmod } = await import('fs/promises');
    await chmod(FAKE_IMAGES_DIR, 0o555);

    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);

    try {
      await codex.generateImage({ prompt: 'a fox' });
      const child = spawnCalls[0].child;
      child.stderr.emit('data', Buffer.from(`session id: ${sessionId}\n`));
      child.exitCode = 0;
      child.emit('close', 0, null);

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && failedListener.mock.calls.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(failedListener).toHaveBeenCalledTimes(1);
      expect(failedListener.mock.calls[0][0].error).toMatch(/post-exit handler failed/i);
      expect(unhandled).toBeNull();
    } finally {
      // Restore write perms so afterEach cleanup can rm the tree.
      await chmod(FAKE_IMAGES_DIR, 0o755).catch(() => {});
      process.off('unhandledRejection', onUnhandled);
    }
  }, 8000);

  it('emits a failed event when codex exits non-zero', async () => {
    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await codex.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    child.stderr.emit('data', Buffer.from('boom: out of quota\n'));
    child.exitCode = 1;
    child.emit('close', 1, null);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(failedListener).toHaveBeenCalledTimes(1);
    expect(failedListener.mock.calls[0][0].error).toMatch(/Exit code 1|generation failed/i);
  });
});

describe('codex provider — internals', () => {
  it('SESSION_ID_RE matches the codex banner format', () => {
    const banner = `OpenAI Codex v0.125.0
workdir: /tmp/x
model: gpt-5.5
session id: 019dd59e-a8da-7bd2-a7d8-4ac6f46e7b07
something else`;
    const m = banner.match(codex._internals.SESSION_ID_RE);
    expect(m).toBeTruthy();
    expect(m[1]).toBe('019dd59e-a8da-7bd2-a7d8-4ac6f46e7b07');
  });

  it('codexImagesDir resolves under the user homedir', () => {
    const dir = codex._internals.codexImagesDir('abc');
    expect(dir.endsWith(join('.codex', 'generated_images', 'abc'))).toBe(true);
  });
});

describe('codex provider — noImageReason (no-image diagnostics)', () => {
  it('flags a "generated" claim with no file as tool-unavailable / rate-limited', () => {
    const msg = codex.noImageReason('codex\nGenerated with the built-in image tool using the imagegen skill.\ntokens used\n11484');
    expect(msg).toMatch(/wrote no image file/i);
    expect(msg).toMatch(/unavailable or rate-limited/i);
    // the model's own words are surfaced…
    expect(msg).toContain('Generated with the built-in image tool');
    // …but codex's structural labels + token count are stripped out
    expect(msg).not.toMatch(/\b11484\b/);
    expect(msg).not.toMatch(/tokens used/i);
  });

  it('surfaces a content-decline message verbatim', () => {
    const msg = codex.noImageReason('codex\nI can’t create that image because it depicts explicit content.\n');
    expect(msg).toMatch(/did not produce an image/i);
    expect(msg).toContain('depicts explicit content');
    expect(msg).not.toMatch(/rate-limited/i);
  });

  it('falls back to the account/enablement hint when codex said nothing usable', () => {
    expect(codex.noImageReason('')).toMatch(/may not allow image_gen/i);
    expect(codex.noImageReason('codex\nuser\n----\ntokens used\n42')).toMatch(/may not allow image_gen/i);
  });

  it('strips ANSI escape codes from the surfaced narration', () => {
    const ESC = String.fromCharCode(27);
    const msg = codex.noImageReason(`${ESC}[1mI can’t make that.${ESC}[0m`);
    expect(msg).toContain('I can’t make that.');
    expect(msg).not.toContain(ESC);
    expect(msg).not.toMatch(/\[\d+m/);
  });
});
