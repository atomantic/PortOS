import { describe, it, expect } from 'vitest';
import {
  CODEX_CONFIGURED_DEFAULT,
  isCodexConfiguredDefault,
  resolveCliModel,
  filterSelectableModels,
  hasModelFlag,
  extractBakedModel
} from './providerModels.js';

describe('providerModels', () => {
  describe('isCodexConfiguredDefault', () => {
    it('matches the sentinel exactly', () => {
      expect(isCodexConfiguredDefault(CODEX_CONFIGURED_DEFAULT)).toBe(true);
      expect(isCodexConfiguredDefault('codex-configured-default')).toBe(true);
    });

    it('rejects everything else', () => {
      expect(isCodexConfiguredDefault('gpt-5')).toBe(false);
      expect(isCodexConfiguredDefault('')).toBe(false);
      expect(isCodexConfiguredDefault(null)).toBe(false);
      expect(isCodexConfiguredDefault(undefined)).toBe(false);
    });
  });

  describe('resolveCliModel', () => {
    it('returns null for the codex sentinel so --model is omitted', () => {
      expect(resolveCliModel(CODEX_CONFIGURED_DEFAULT)).toBeNull();
    });

    it('returns null for empty / nullish values', () => {
      expect(resolveCliModel(null)).toBeNull();
      expect(resolveCliModel(undefined)).toBeNull();
      expect(resolveCliModel('')).toBeNull();
    });

    it('returns the model string when concrete', () => {
      expect(resolveCliModel('gpt-5')).toBe('gpt-5');
      expect(resolveCliModel('claude-opus-4-7')).toBe('claude-opus-4-7');
    });
  });

  describe('filterSelectableModels', () => {
    it('strips the codex sentinel from the list', () => {
      expect(filterSelectableModels(['a', CODEX_CONFIGURED_DEFAULT, 'b'])).toEqual(['a', 'b']);
    });

    it('returns an empty list for nullish input', () => {
      expect(filterSelectableModels(null)).toEqual([]);
      expect(filterSelectableModels(undefined)).toEqual([]);
    });

    it('passes a sentinel-free list through unchanged', () => {
      expect(filterSelectableModels(['a', 'b'])).toEqual(['a', 'b']);
    });
  });

  describe('hasModelFlag', () => {
    it('detects --model with separated value', () => {
      expect(hasModelFlag(['--model', 'gpt-5'])).toBe(true);
    });

    it('detects -m with separated value', () => {
      expect(hasModelFlag(['-m', 'gpt-5'])).toBe(true);
    });

    it('detects joined --model=value', () => {
      expect(hasModelFlag(['--model=gpt-5'])).toBe(true);
    });

    it('detects joined -m=value', () => {
      expect(hasModelFlag(['-m=gpt-5'])).toBe(true);
    });

    it('returns false for separated flag at end of argv', () => {
      expect(hasModelFlag(['--foo', '--model'])).toBe(false);
    });

    it('returns false when separated --model is followed by another flag', () => {
      expect(hasModelFlag(['--model', '--other'])).toBe(false);
    });

    it('returns false for joined form with no value (`--model=`)', () => {
      expect(hasModelFlag(['--model='])).toBe(false);
      expect(hasModelFlag(['-m='])).toBe(false);
    });

    it('returns false for unrelated argv', () => {
      expect(hasModelFlag(['--verbose', 'exec', '-'])).toBe(false);
      expect(hasModelFlag([])).toBe(false);
    });

    it('returns false for non-array input', () => {
      expect(hasModelFlag(null)).toBe(false);
      expect(hasModelFlag('not-an-array')).toBe(false);
    });
  });

  describe('extractBakedModel', () => {
    it('extracts from separated --model form', () => {
      expect(extractBakedModel(['--model', 'gpt-5'])).toBe('gpt-5');
    });

    it('extracts from separated -m form', () => {
      expect(extractBakedModel(['-m', 'gpt-5'])).toBe('gpt-5');
    });

    it('extracts from joined --model=value form', () => {
      expect(extractBakedModel(['--model=gpt-5'])).toBe('gpt-5');
    });

    it('extracts from joined -m=value form', () => {
      expect(extractBakedModel(['-m=gpt-5'])).toBe('gpt-5');
    });

    it('returns null when separated form has no value', () => {
      expect(extractBakedModel(['--model'])).toBeNull();
      expect(extractBakedModel(['--model', '--other'])).toBeNull();
    });

    it('returns null when joined form has empty value', () => {
      expect(extractBakedModel(['--model='])).toBeNull();
      expect(extractBakedModel(['-m='])).toBeNull();
    });

    it('returns null when no model flag is present', () => {
      expect(extractBakedModel(['--verbose', 'exec'])).toBeNull();
      expect(extractBakedModel([])).toBeNull();
    });

    it('returns null for non-array input', () => {
      expect(extractBakedModel(null)).toBeNull();
      expect(extractBakedModel(undefined)).toBeNull();
    });
  });

  it('extractBakedModel returning a value implies hasModelFlag is true', () => {
    // The sound direction: if extractBakedModel finds a real value, the args
    // definitely contain a usable model flag. The reverse direction does NOT
    // hold for adversarial argv shapes — extractBakedModel returns early on
    // the first --model/-m it sees and may give up (returning null) on a
    // valueless first flag even when a later --model has a real value.
    const shapes = [
      ['--model', 'gpt-5'],
      ['-m', 'gpt-5'],
      ['--model=gpt-5'],
      ['-m=gpt-5'],
      ['--model'],
      ['--model='],
      // Adversarial: first flag has no value, second one does. Documents
      // current early-exit behavior — extractBakedModel returns null on the
      // first '--model' (because next is '--other'), so hasModelFlag may
      // disagree with it. We only assert the sound direction.
      ['--model', '--other', '--model', 'gpt-5'],
      // Mixed argv with other tool flags before the model pin.
      ['--temperature', '0.7', '--model', 'gpt-5']
    ];
    for (const args of shapes) {
      const has = hasModelFlag(args);
      const baked = extractBakedModel(args);
      if (baked !== null) {
        expect(has, `args=${JSON.stringify(args)}`).toBe(true);
      }
    }
  });
});
