/**
 * The provider-reference grammar (#7564): which strings name a preset, which
 * name a composite, and which name nothing — pinned on the exact examples the
 * epic's acceptance criteria list, plus the boundary the two grammars share.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPOSITE_ID_RE,
  MAX_PROVIDER_REF_LENGTH,
  PRESET_ID_RE,
  formatCompositeId,
  isCompositeProviderId,
  isPresetProviderId,
  parseProviderRef,
} from './providerRef.js';

describe('parseProviderRef', () => {
  it('reads a preset record id', () => {
    expect(parseProviderRef('claude-code')).toEqual({ kind: 'preset', id: 'claude-code' });
    expect(isPresetProviderId('codex-configured-default')).toBe(true);
    expect(isCompositeProviderId('claude-code')).toBe(false);
  });

  it('reads every composite part, with the bootstrap suffix optional', () => {
    expect(parseProviderRef('pi.tui@nvidia-nim-free')).toEqual({
      kind: 'composite', id: 'pi.tui@nvidia-nim-free', harnessId: 'pi', method: 'tui', serviceSlug: 'nvidia-nim-free', bootstrapSlug: null,
    });
    expect(parseProviderRef('claude.cli@anthropic+corp-auth')).toEqual({
      kind: 'composite', id: 'claude.cli@anthropic+corp-auth', harnessId: 'claude', method: 'cli', serviceSlug: 'anthropic', bootstrapSlug: 'corp-auth',
    });
    expect(parseProviderRef('direct.api@ollama')).toMatchObject({ kind: 'composite', harnessId: 'direct', method: 'api', serviceSlug: 'ollama' });
    expect(isCompositeProviderId('opencode.cli@openrouter')).toBe(true);
  });

  it.each([
    ['pi.tui@Nvidia', 'an uppercase service slug'],
    ['pi.tui@', 'an empty service slug'],
    ['pi.gui@x', 'a method that is not cli/tui/api'],
    ['direct.api@ollama+corp-auth', 'a bootstrap suffix on the api method'],
    ['pi.tui@-nvidia', 'a slug starting with a hyphen'],
    ['pi@nvidia', 'no method'],
    ['.tui@nvidia', 'no harness'],
    ['Claude-Code', 'an uppercase preset'],
    ['', 'an empty string'],
    ['__proto__', 'a prototype key'],
    ['a'.repeat(MAX_PROVIDER_REF_LENGTH + 1), 'an over-long reference'],
  ])('rejects %s (%s)', (id) => {
    expect(parseProviderRef(id)).toBeNull();
    expect(isCompositeProviderId(id)).toBe(false);
    expect(isPresetProviderId(id)).toBe(false);
  });

  it('never reads a non-string', () => {
    for (const value of [null, undefined, 42, {}, ['pi.tui@nvidia-nim']]) expect(parseProviderRef(value)).toBeNull();
  });

  it('keeps the two grammars disjoint: no string matches both', () => {
    for (const id of ['claude-code', 'pi.tui@nvidia-nim', 'direct.api@ollama', 'claude.cli@anthropic+corp-auth']) {
      expect(PRESET_ID_RE.test(id)).not.toBe(COMPOSITE_ID_RE.test(id));
    }
  });
});

describe('formatCompositeId', () => {
  it('round-trips through parseProviderRef', () => {
    const parts = { harnessId: 'opencode', method: 'cli', serviceSlug: 'openrouter-free', bootstrapSlug: 'corp-auth' };
    const id = formatCompositeId(parts);
    expect(id).toBe('opencode.cli@openrouter-free+corp-auth');
    expect(parseProviderRef(id)).toEqual({ kind: 'composite', id, ...parts });
    expect(formatCompositeId({ harnessId: 'direct', method: 'api', serviceSlug: 'ollama' })).toBe('direct.api@ollama');
  });

  it('refuses parts that would not parse back', () => {
    expect(() => formatCompositeId({ harnessId: 'direct', method: 'api', serviceSlug: 'ollama', bootstrapSlug: 'x' })).toThrow(/not a composite/);
    expect(() => formatCompositeId({ harnessId: 'pi', method: 'gui', serviceSlug: 'x' })).toThrow(/not a composite/);
    expect(() => formatCompositeId({ harnessId: 'pi', method: 'tui', serviceSlug: 'Nvidia' })).toThrow(/not a composite/);
  });
});
