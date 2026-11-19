import { describe, expect, it } from 'vitest';
import { assertHeaderSafeKey, isHeaderSafeKey } from './headerSafeKey.js';
import { videoGenSettingsSchema } from './settingsValidation.js';

const UNSAFE = { emoji: 'abc\u{1F600}def', 'inner space': 'abc def', 'trailing newline': 'abc\n', 'latin-1 only': 'abcé' };

describe('header-safe hosted provider keys', () => {
  it('accepts KEY_ID:KEY_SECRET shaped keys and refuses unsendable ones', () => {
    expect(isHeaderSafeKey('0a1b-2c:Zz9_secret.value+/=')).toBe(true);
    for (const value of Object.values(UNSAFE)) expect(isHeaderSafeKey(value)).toBe(false);
  });

  it.each(Object.entries(UNSAFE))('render guard rejects %s with a plain message that never echoes the key', (_name, key) => {
    let error;
    try { assertHeaderSafeKey(key, 'Higgsfield'); } catch (e) { error = e; }
    expect(error.status).toBe(400);
    expect(error.message).toBe('The saved Higgsfield API key contains characters that cannot be sent (whitespace, control or non-ASCII characters). Paste it again in Settings.');
    expect(error.message).not.toContain('abc');
  });

  it('passes an absent key through for the not-configured path', () => {
    expect(assertHeaderSafeKey(null, 'Runway')).toBeNull();
  });

  it.each(['fal', 'reactor', 'runway', 'higgsfield', 'google'])('settings schema for %s refuses unsafe keys, names the provider and clears on empty string', (provider) => {
    for (const value of Object.values(UNSAFE)) {
      const parsed = videoGenSettingsSchema.safeParse({ [provider]: { apiKey: value } });
      expect(parsed.success).toBe(false);
      expect(parsed.error.issues[0].message).toMatch(/API key contains characters that cannot be sent/);
    }
    expect(videoGenSettingsSchema.safeParse({ [provider]: { apiKey: 'good_key-1' } }).success).toBe(true);
    expect(videoGenSettingsSchema.parse({ [provider]: { apiKey: '' } })[provider].apiKey).toBeUndefined();
  });
});
