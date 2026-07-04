import { describe, it, expect } from 'vitest';
import { sanitizeScreenshotRefs, providerSchema, validate } from './validation.js';

describe('sanitizeScreenshotRefs — POST /api/runs screenshot hardening (#1870)', () => {
  it('keeps an in-dir image basename unchanged', () => {
    expect(sanitizeScreenshotRefs(['shot.png'])).toEqual({ safe: ['shot.png'], rejected: [] });
  });

  it('neutralizes the legit absolute path the RunnerPage uploads under data/screenshots to its basename', () => {
    // /api/screenshots returns an absolute `path`; the RunnerPage forwards it
    // verbatim — basename rebases it to a screenshots-dir-relative ref.
    expect(sanitizeScreenshotRefs(['/home/user/portos/data/screenshots/grab.png']))
      .toEqual({ safe: ['grab.png'], rejected: [] });
  });

  it('rejects `../` traversal that escapes to a non-image file', () => {
    const { safe, rejected } = sanitizeScreenshotRefs(['../../../../etc/passwd']);
    expect(safe).toEqual([]);
    expect(rejected).toEqual(['../../../../etc/passwd']);
  });

  it('rejects an absolute path to a non-image file outside the screenshots dir', () => {
    const { safe, rejected } = sanitizeScreenshotRefs(['/etc/passwd']);
    expect(safe).toEqual([]);
    expect(rejected).toEqual(['/etc/passwd']);
  });

  it('collapses a traversal path that happens to end in an image extension to a harmless in-dir basename', () => {
    // basename neutralizes the escape; the result is a screenshots-dir ref that
    // simply won't exist (the loader then skips it) — never an arbitrary read.
    expect(sanitizeScreenshotRefs(['../../secret/evil.png'])).toEqual({ safe: ['evil.png'], rejected: [] });
  });

  it('rejects disallowed extensions and dotfiles with no extension', () => {
    expect(sanitizeScreenshotRefs(['notes.txt', '.env']))
      .toEqual({ safe: [], rejected: ['notes.txt', '.env'] });
  });

  it('is case-insensitive on the extension allow-list', () => {
    expect(sanitizeScreenshotRefs(['Shot.PNG', 'pic.JPEG']))
      .toEqual({ safe: ['Shot.PNG', 'pic.JPEG'], rejected: [] });
  });

  it('partitions a mixed list into safe + rejected', () => {
    const { safe, rejected } = sanitizeScreenshotRefs([
      'a.png',
      '../../../../etc/passwd',
      'b.webp',
      'readme.md',
    ]);
    expect(safe).toEqual(['a.png', 'b.webp']);
    expect(rejected).toEqual(['../../../../etc/passwd', 'readme.md']);
  });

  it('treats non-string and empty entries as rejected', () => {
    const { safe, rejected } = sanitizeScreenshotRefs(['ok.png', '', 42, null]);
    expect(safe).toEqual(['ok.png']);
    expect(rejected).toEqual(['', '42', 'null']);
  });

  it('returns empty partitions for a non-array input', () => {
    expect(sanitizeScreenshotRefs(undefined)).toEqual({ safe: [], rejected: [] });
    expect(sanitizeScreenshotRefs('x.png')).toEqual({ safe: [], rejected: [] });
  });
});

const minimalProvider = { name: 'Codex CLI', type: 'cli' };

describe('providerSchema', () => {
  it('accepts a minimal cli provider (name + type only)', () => {
    expect(providerSchema.safeParse(minimalProvider).success).toBe(true);
  });

  describe('endpoint empty-string/null → undefined coercion', () => {
    it('coerces endpoint: "" to undefined so the URL check is skipped for CLI providers', () => {
      const r = providerSchema.safeParse({ ...minimalProvider, endpoint: '' });
      expect(r.success).toBe(true);
      expect(r.data.endpoint).toBeUndefined();
    });

    it('coerces endpoint: null to undefined', () => {
      const r = providerSchema.safeParse({ ...minimalProvider, endpoint: null });
      expect(r.success).toBe(true);
      expect(r.data.endpoint).toBeUndefined();
    });

    it('keeps a valid URL endpoint', () => {
      const r = providerSchema.safeParse({ ...minimalProvider, type: 'api', endpoint: 'https://api.example.com' });
      expect(r.success).toBe(true);
      expect(r.data.endpoint).toBe('https://api.example.com');
    });

    it('rejects a non-empty, non-URL endpoint', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, endpoint: 'not-a-url' }).success).toBe(false);
    });
  });

  describe('id slug regex', () => {
    it('accepts a lowercase-alphanumeric-with-hyphens id', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'codex' }).success).toBe(true);
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'claude-ollama-1' }).success).toBe(true);
    });

    it('rejects uppercase, leading hyphen, and disallowed characters', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'Codex' }).success).toBe(false);
      expect(providerSchema.safeParse({ ...minimalProvider, id: '-codex' }).success).toBe(false);
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'codex_cli' }).success).toBe(false);
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'codex cli' }).success).toBe(false);
    });

    it('rejects an id over the 80-char max', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'a'.repeat(81) }).success).toBe(false);
      expect(providerSchema.safeParse({ ...minimalProvider, id: 'a'.repeat(80) }).success).toBe(true);
    });
  });

  describe('numCtx 512–1048576 bounds', () => {
    it('accepts values at the inclusive bounds', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, numCtx: 512 }).success).toBe(true);
      expect(providerSchema.safeParse({ ...minimalProvider, numCtx: 1048576 }).success).toBe(true);
    });

    it('rejects values below 512 and above 1048576', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, numCtx: 511 }).success).toBe(false);
      expect(providerSchema.safeParse({ ...minimalProvider, numCtx: 1048577 }).success).toBe(false);
    });

    it('rejects a non-integer numCtx', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, numCtx: 1024.5 }).success).toBe(false);
    });

    it('accepts null (unset)', () => {
      expect(providerSchema.safeParse({ ...minimalProvider, numCtx: null }).success).toBe(true);
    });
  });

  describe('type enum + required name', () => {
    it('rejects an unknown type and a missing/empty name', () => {
      expect(providerSchema.safeParse({ name: 'X', type: 'magic' }).success).toBe(false);
      expect(providerSchema.safeParse({ type: 'cli' }).success).toBe(false);
      expect(providerSchema.safeParse({ name: '', type: 'cli' }).success).toBe(false);
    });

    it('accepts each valid type', () => {
      for (const type of ['cli', 'api', 'tui']) {
        expect(providerSchema.safeParse({ name: 'X', type }).success).toBe(true);
      }
    });
  });
});

describe('validate', () => {
  it('returns { success: true, data } for valid input', () => {
    const result = validate(providerSchema, minimalProvider);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ name: 'Codex CLI', type: 'cli' });
    expect(result.errors).toBeUndefined();
  });

  it('returns { success: false, errors: [{ path, message }] } for invalid input', () => {
    const result = validate(providerSchema, { type: 'magic' });
    expect(result.success).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const e of result.errors) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
    }
    // name is missing and type is invalid — both should surface.
    const paths = result.errors.map(e => e.path);
    expect(paths).toContain('name');
    expect(paths).toContain('type');
  });

  it('joins a nested error path with dots', () => {
    // models must be an array of strings — a numeric element produces a path
    // like 'models.0'.
    const result = validate(providerSchema, { ...minimalProvider, models: [42] });
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.path === 'models.0')).toBe(true);
  });
});
