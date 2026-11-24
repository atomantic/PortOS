import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from './mockPathsDataRoot.js';
import { PATHS } from './paths.js';
import { assertSafeFilename, isSafeFilename, isPathInsideDir, resolveScreenshot, resolveImageInputPath } from './pathSafety.js';

vi.mock('./paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => join(lazyTempDataRoot('path-safety-test-'), 'data'),
}));
afterAll(cleanupTempDataRoots);

const __dirname_test = dirname(fileURLToPath(import.meta.url));

describe('fileUtils', () => {
  describe('isPathInsideDir', () => {
    it('accepts a file directly inside the directory', () => {
      expect(isPathInsideDir('/data/uploads', '/data/uploads/foo.png')).toBe(true);
      expect(isPathInsideDir('/data/uploads', '/data/uploads/sub/foo.png')).toBe(true);
    });

    it('rejects a traversal that escapes the directory', () => {
      expect(isPathInsideDir('/data/uploads', '/data/uploads/../etc/passwd')).toBe(false);
      expect(isPathInsideDir('/data/uploads', '/etc/passwd')).toBe(false);
    });

    // Windows and macOS filesystems are case-insensitive, so two spellings of
    // one directory are one directory. A case-SENSITIVE prefix compare reported
    // a managed worktree as `worktree-unmanaged-location` and the reaper
    // silently never reaped it — git reports paths its own way (drive-letter
    // case, 8.3 short names), which need not match how PortOS spelled the root.
    it('matches case-insensitively only where the filesystem is', () => {
      const insensitive = process.platform === 'win32' || process.platform === 'darwin';
      expect(isPathInsideDir('/data/Uploads', '/data/uploads/foo.png')).toBe(insensitive);
      expect(isPathInsideDir('/data/uploads', '/data/UPLOADS/sub/foo.png')).toBe(insensitive);
    });

    // Case-folding must only ever recognize the SAME directory — never widen
    // containment to a sibling or admit a traversal.
    it('still rejects escapes and prefix-sibling directories under case-folding', () => {
      expect(isPathInsideDir('/data/Uploads', '/data/uploads-evil/foo.png')).toBe(false);
      expect(isPathInsideDir('/data/Uploads', '/data/UPLOADS/../etc/passwd')).toBe(false);
      expect(isPathInsideDir('/data/Uploads', '/etc/passwd')).toBe(false);
      // The root itself is not "inside" itself, in either casing.
      expect(isPathInsideDir('/data/Uploads', '/data/uploads')).toBe(false);
    });

    it('rejects a sibling dir whose name merely starts with the root (the trailing-sep bug)', () => {
      // The old `startsWith(DIR)` check without a trailing separator let
      // `/data/uploads-evil/x` slip through because the string prefix matched.
      expect(isPathInsideDir('/data/uploads', '/data/uploads-evil/x.png')).toBe(false);
    });

    it('rejects the root itself (no trailing separator on the bare root)', () => {
      expect(isPathInsideDir('/data/uploads', '/data/uploads')).toBe(false);
    });

    it('returns false for non-string / empty inputs', () => {
      expect(isPathInsideDir('/data/uploads', '')).toBe(false);
      expect(isPathInsideDir('', '/data/uploads/foo.png')).toBe(false);
      expect(isPathInsideDir(null, undefined)).toBe(false);
    });
  });

  describe('assertSafeFilename', () => {
    it('accepts a safe basename with an allowlisted extension', () => {
      expect(() => assertSafeFilename('foo.png', { extensions: ['.png'] })).not.toThrow();
      expect(() => assertSafeFilename('lora-cool.safetensors', { extensions: ['.safetensors'] })).not.toThrow();
    });

    it('matches extensions case-insensitively', () => {
      expect(() => assertSafeFilename('FOO.PNG', { extensions: ['.png'] })).not.toThrow();
      expect(() => assertSafeFilename('cool.SafeTensors', { extensions: ['.safetensors'] })).not.toThrow();
    });

    it('allows substring `..` in the middle of a name', () => {
      expect(() => assertSafeFilename('my..render.png', { extensions: ['.png'] })).not.toThrow();
    });

    it('rejects path separators', () => {
      expect(() => assertSafeFilename('sub/foo.png', { extensions: ['.png'] })).toThrow(/Invalid filename/);
      expect(() => assertSafeFilename('sub\\foo.png', { extensions: ['.png'] })).toThrow(/Invalid filename/);
    });

    it('rejects exact-traversal `.` and `..`', () => {
      expect(() => assertSafeFilename('.', { extensions: ['.png'] })).toThrow(/Invalid filename/);
      expect(() => assertSafeFilename('..', { extensions: ['.png'] })).toThrow(/Invalid filename/);
    });

    it('rejects null bytes', () => {
      expect(() => assertSafeFilename('foo\0.png', { extensions: ['.png'] })).toThrow(/Invalid filename/);
    });

    it('rejects empty or non-string inputs', () => {
      expect(() => assertSafeFilename('', { extensions: ['.png'] })).toThrow(/Filename required/);
      expect(() => assertSafeFilename(undefined, { extensions: ['.png'] })).toThrow(/Filename required/);
      expect(() => assertSafeFilename(null, { extensions: ['.png'] })).toThrow(/Filename required/);
    });

    it('rejects unrecognized extensions', () => {
      expect(() => assertSafeFilename('foo.jpg', { extensions: ['.png'] })).toThrow(/Invalid filename/);
      expect(() => assertSafeFilename('foo.exe', { extensions: ['.png', '.gif'] })).toThrow(/Invalid filename/);
    });

    it('uses subject in error messages', () => {
      expect(() => assertSafeFilename('', { extensions: ['.safetensors'], subject: 'LoRA filename' }))
        .toThrow(/LoRA filename required/);
      expect(() => assertSafeFilename('foo.jpg', { extensions: ['.safetensors'], subject: 'LoRA filename' }))
        .toThrow(/Invalid LoRA filename/);
    });

    it('throws on missing extensions option (programmer error, not user)', () => {
      expect(() => assertSafeFilename('foo.png', {})).toThrow(/extensions allowlist is required/);
      expect(() => assertSafeFilename('foo.png', { extensions: [] })).toThrow(/extensions allowlist is required/);
    });

    it('throws on extensions that do not start with a dot (programmer error)', () => {
      // Bare suffix like 'png' would also match 'not-an-imagepng' if we didn't
      // enforce the leading-dot rule — that's a serious validation hole.
      expect(() => assertSafeFilename('foo.png', { extensions: ['png'] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: ['.png', 'jpg'] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: [''] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: ['.'] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: [123] }))
        .toThrow(/each extension must be a non-empty string starting with/);
    });

    // `isSafeFilename` is the same rule as a predicate, for read-only callers
    // that must report a bad name as data. The two share one implementation, so
    // the contract worth pinning is that they never disagree — a future edit to
    // either must keep the gate and the reported verdict in lockstep.
    it('agrees with isSafeFilename on every input class', () => {
      const extensions = ['.png', '.mp3'];
      const cases = [
        'foo.png', 'FOO.PNG', 'x.mp3', 'my..render.png', // accepted
        'foo.jpg', 'png', 'foo.png.txt', // bad extension
        'sub/foo.png', 'sub\\foo.png', '/foo.png', '../foo.png', '..\\foo.png', // separators
        '.', '..', // exact traversal
        'foo\0.png', '\0', // null bytes
        '', null, undefined, 0, false, [], {}, // missing / non-string
      ];
      for (const name of cases) {
        let threw = false;
        try {
          assertSafeFilename(name, { extensions });
        } catch {
          threw = true;
        }
        expect(isSafeFilename(name, extensions), `disagreed on ${JSON.stringify(name)}`)
          .toBe(!threw);
      }
    });

    it('honors requiredMessage override for the missing-input case only', () => {
      // Backward-compat path: wrappers that used to throw a fixed phrase
      // (e.g. "Filename required" / "Invalid filename") can preserve that
      // message without affecting the invalid-input message.
      expect(() => assertSafeFilename('', {
        extensions: ['.safetensors'],
        subject: 'LoRA filename',
        requiredMessage: 'Filename required',
      })).toThrow(/^Filename required$/);
      // Invalid path still uses the subject-derived message.
      expect(() => assertSafeFilename('foo.jpg', {
        extensions: ['.safetensors'],
        subject: 'LoRA filename',
        requiredMessage: 'Filename required',
      })).toThrow(/^Invalid LoRA filename$/);
    });

    it('attaches 400 status + VALIDATION_ERROR code on the thrown ServerError', () => {
      try {
        assertSafeFilename('bad/path.png', { extensions: ['.png'] });
        throw new Error('Expected assertion to throw');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('resolveImageInputPath', () => {
    const sampleTemplate = join(__dirname_test, '..', '..', 'data.reference', 'templates', 'character-reference-sheet.png');
    const galleryName = 'fileutils-test-gallery.png';
    const refsName = 'fileutils-test-refs.png';
    const templateName = 'fileutils-test-template.png';
    const galleryPath = join(PATHS.images, galleryName);
    const refsPath = join(PATHS.imageRefs, refsName);
    const templatePath = join(PATHS.visualTemplates, templateName);

    beforeEach(() => {
      // Provision fixtures in each approved root so the resolver can find
      // them. Reuses the shipped sample asset as a stand-in PNG body.
      for (const root of [PATHS.images, PATHS.imageRefs, PATHS.visualTemplates]) {
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
      }
      if (existsSync(sampleTemplate)) {
        if (!existsSync(galleryPath)) copyFileSync(sampleTemplate, galleryPath);
        if (!existsSync(refsPath)) copyFileSync(sampleTemplate, refsPath);
        if (!existsSync(templatePath)) copyFileSync(sampleTemplate, templatePath);
      }
    });


    it('returns null for non-string / empty input', () => {
      expect(resolveImageInputPath(null)).toBeNull();
      expect(resolveImageInputPath('')).toBeNull();
      expect(resolveImageInputPath(undefined)).toBeNull();
      expect(resolveImageInputPath(123)).toBeNull();
    });

    it('resolves a basename present in the gallery (first root)', () => {
      const out = resolveImageInputPath(galleryName);
      expect(out).toBeTruthy();
      expect(out).toContain(join('data', 'images'));
      expect(out).toContain(galleryName);
    });

    it('resolves a basename present only in image-refs', () => {
      const out = resolveImageInputPath(refsName);
      expect(out).toBeTruthy();
      expect(out).toContain(join('data', 'image-refs'));
    });

    it('resolves a basename present only in visualTemplates', () => {
      const out = resolveImageInputPath(templateName);
      // `templateName` is unique to the visualTemplates root (it is NOT copied
      // into gallery or image-refs), so the resolver must land on the third
      // root and the returned path must carry that root's segment + basename —
      // a plain truthiness check would pass even on a wrong-root resolution.
      expect(out).toContain(join('data', 'templates'));
      expect(out).toContain(templateName);
    });

    it('REGRESSION: absolute path under a specific root stays in that root', () => {
      // Bug it guards: previously the resolver basenamed any input and tried
      // each root in order — so `/data/templates/<name>.png` for a file that
      // also exists in `/data/images/<name>.png` would silently redirect to
      // the gallery copy. Reference-sheet renders would have used the wrong
      // init image. Verify each absolute path resolves to its own root.
      const galleryAbs = join(PATHS.images, galleryName);
      const refsAbs = join(PATHS.imageRefs, refsName);
      const templateAbs = join(PATHS.visualTemplates, templateName);

      expect(resolveImageInputPath(galleryAbs)).toContain(join('data', 'images'));
      expect(resolveImageInputPath(refsAbs)).toContain(join('data', 'image-refs'));
      expect(resolveImageInputPath(templateAbs)).toContain(join('data', 'templates'));
    });

    it('REGRESSION: same basename in multiple roots — absolute path picks the matching root', () => {
      // All three fixtures share the same body (copied from sampleTemplate),
      // but the absolute path should pin to its own root, NOT collapse to
      // the gallery via basename fallback.
      const refsAbs = join(PATHS.imageRefs, refsName);
      const out = resolveImageInputPath(refsAbs);
      expect(out).toContain(join('data', 'image-refs'));
      expect(out).not.toContain(join('data', 'images'));
    });
  });

  describe('resolveScreenshot', () => {
    const sampleTemplate = join(__dirname_test, '..', '..', 'data.reference', 'templates', 'character-reference-sheet.png');
    const shotName = 'fileutils-test-screenshot.png';
    const shotPath = join(PATHS.screenshots, shotName);

    beforeEach(() => {
      if (!existsSync(PATHS.screenshots)) mkdirSync(PATHS.screenshots, { recursive: true });
      if (existsSync(sampleTemplate) && !existsSync(shotPath)) copyFileSync(sampleTemplate, shotPath);
    });


    it('resolves a basename present under the screenshots root', () => {
      const out = resolveScreenshot(shotName);
      expect(out).toBeTruthy();
      expect(out).toContain(join('data', 'screenshots'));
      expect(out).toContain(shotName);
    });

    it('SECURITY: rejects parent-directory traversal that escapes the screenshots root', () => {
      // `loadImageAsBase64` (issue #1820) fed `imagePath` straight from req.body;
      // a `../` payload must NOT resolve to a file outside data/screenshots.
      expect(resolveScreenshot('../../etc/passwd')).toBeNull();
      expect(resolveScreenshot('../package.json')).toBeNull();
    });

    it('SECURITY: rejects an absolute path outside the screenshots root', () => {
      expect(resolveScreenshot('/etc/passwd')).toBeNull();
      expect(resolveScreenshot('/etc/hosts')).toBeNull();
    });

    it('rejects non-image extensions and missing files', () => {
      expect(resolveScreenshot('notes.txt')).toBeNull();
      expect(resolveScreenshot('does-not-exist.png')).toBeNull();
    });

    it('returns null for non-string / empty input', () => {
      expect(resolveScreenshot(null)).toBeNull();
      expect(resolveScreenshot('')).toBeNull();
      expect(resolveScreenshot(undefined)).toBeNull();
    });
  });
});
