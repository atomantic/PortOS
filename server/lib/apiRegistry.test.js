import { describe, it, expect } from 'vitest';
import { API_REGISTRY, isRegistryPublic, resolveApiAccess } from './apiRegistry.js';

const settingsWith = (apiAccess) => ({ apiAccess });

describe('apiRegistry', () => {
  describe('API_REGISTRY shape', () => {
    it('declares voice and sdapi with required fields', () => {
      const ids = API_REGISTRY.map((a) => a.id);
      expect(ids).toContain('voice');
      expect(ids).toContain('sdapi');
      for (const entry of API_REGISTRY) {
        expect(typeof entry.id).toBe('string');
        expect(typeof entry.label).toBe('string');
        expect(Array.isArray(entry.publicPrefixes)).toBe(true);
        expect(entry.publicPrefixes.length).toBeGreaterThan(0);
        expect(typeof entry.settingsKey).toBe('string');
        expect(typeof entry.defaults.exposed).toBe('boolean');
        expect(typeof entry.defaults.requireAuth).toBe('boolean');
      }
    });

    it('defaults both APIs to not-exposed + passwordless', () => {
      for (const entry of API_REGISTRY) {
        expect(entry.defaults.exposed).toBe(false);
        expect(entry.defaults.requireAuth).toBe(false);
      }
    });

    it('never lists a mutation/config path in publicPrefixes', () => {
      const voice = API_REGISTRY.find((a) => a.id === 'voice');
      // The voice public surface is a dedicated sub-mount, NOT the main router.
      expect(voice.publicPrefixes).toEqual(['/api/voice/public/']);
      expect(voice.publicPrefixes.some((p) => p === '/api/voice/')).toBe(false);
    });
  });

  describe('isRegistryPublic', () => {
    it('returns false when no apiAccess settings present (pre-migration)', () => {
      expect(isRegistryPublic({}, '/api/voice/public/synthesize')).toBe(false);
      expect(isRegistryPublic(undefined, '/api/voice/public/synthesize')).toBe(false);
    });

    it('opens a public prefix when exposed && !requireAuth', () => {
      const s = settingsWith({ voice: { exposed: true, requireAuth: false } });
      expect(isRegistryPublic(s, '/api/voice/public/synthesize')).toBe(true);
      expect(isRegistryPublic(s, '/api/voice/public/voices')).toBe(true);
    });

    it('stays gated when exposed but requireAuth', () => {
      const s = settingsWith({ voice: { exposed: true, requireAuth: true } });
      expect(isRegistryPublic(s, '/api/voice/public/synthesize')).toBe(false);
    });

    it('stays gated when not exposed even if passwordless', () => {
      const s = settingsWith({ voice: { exposed: false, requireAuth: false } });
      expect(isRegistryPublic(s, '/api/voice/public/synthesize')).toBe(false);
    });

    it('NEVER opens a mutation path even when the API is exposed+passwordless', () => {
      const s = settingsWith({ voice: { exposed: true, requireAuth: false } });
      // These are NOT under /api/voice/public/ — they must stay gated.
      expect(isRegistryPublic(s, '/api/voice/config')).toBe(false);
      expect(isRegistryPublic(s, '/api/voice/whisper')).toBe(false);
      expect(isRegistryPublic(s, '/api/voice/test')).toBe(false);
    });

    it('opens sdapi when exposed+passwordless', () => {
      const s = settingsWith({ sdapi: { exposed: true, requireAuth: false } });
      expect(isRegistryPublic(s, '/sdapi/v1/txt2img')).toBe(true);
    });

    it('resolves each API independently', () => {
      const s = settingsWith({
        voice: { exposed: true, requireAuth: false },
        sdapi: { exposed: false, requireAuth: false },
      });
      expect(isRegistryPublic(s, '/api/voice/public/synthesize')).toBe(true);
      expect(isRegistryPublic(s, '/sdapi/v1/txt2img')).toBe(false);
    });

    it('returns false for non-string path', () => {
      expect(isRegistryPublic(settingsWith({ voice: { exposed: true } }), null)).toBe(false);
    });

    it('fails safe when a corrupted settings.json has non-boolean flags', () => {
      // The auth gate reads settings straight off disk (no Zod), so a
      // hand-edited string like "false" must NOT be treated as truthy.
      const s = settingsWith({ voice: { exposed: 'true', requireAuth: 'false' } });
      expect(isRegistryPublic(s, '/api/voice/public/synthesize')).toBe(false);
    });

    it('treats a non-boolean exposed as the (closed) default', () => {
      const s = settingsWith({ voice: { exposed: 1, requireAuth: false } });
      expect(isRegistryPublic(s, '/api/voice/public/synthesize')).toBe(false);
    });
  });

  describe('resolveApiAccess', () => {
    it('falls back to defaults when apiAccess absent', () => {
      const resolved = resolveApiAccess({});
      const voice = resolved.find((a) => a.id === 'voice');
      expect(voice.exposed).toBe(false);
      expect(voice.requireAuth).toBe(false);
    });

    it('merges persisted flags over defaults', () => {
      const resolved = resolveApiAccess(settingsWith({ voice: { exposed: true, requireAuth: true } }));
      const voice = resolved.find((a) => a.id === 'voice');
      expect(voice.exposed).toBe(true);
      expect(voice.requireAuth).toBe(true);
      // Static metadata preserved.
      expect(voice.label).toBe('Voice / TTS');
      expect(voice.docPaths.length).toBeGreaterThan(0);
    });

    it('uses default for a flag the persisted entry omits', () => {
      const resolved = resolveApiAccess(settingsWith({ voice: { exposed: true } }));
      const voice = resolved.find((a) => a.id === 'voice');
      expect(voice.exposed).toBe(true);
      expect(voice.requireAuth).toBe(false); // default
    });

    it('coerces non-boolean persisted flags to the default', () => {
      const resolved = resolveApiAccess(settingsWith({ voice: { exposed: 'true' } }));
      const voice = resolved.find((a) => a.id === 'voice');
      expect(voice.exposed).toBe(false); // string "true" is not a boolean → default
    });
  });
});
