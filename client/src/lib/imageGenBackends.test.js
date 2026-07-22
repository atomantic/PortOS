import { describe, it, expect } from 'vitest';
import {
  IMAGE_GEN_MODE,
  I2I_CAPABLE_MODES,
  isI2iCapableMode,
  pickI2iMode,
  deriveAvailableBackends,
} from './imageGenBackends';

describe('I2I_CAPABLE_MODES / isI2iCapableMode', () => {
  it('treats local, codex, and grok as i2i-capable, external as not', () => {
    expect(I2I_CAPABLE_MODES).toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK]);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.LOCAL)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.GROK)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.EXTERNAL)).toBe(false);
    expect(isI2iCapableMode(undefined)).toBe(false);
  });
});

describe('pickI2iMode', () => {
  const backend = (id) => ({ id });

  it('prefers local when both local and codex are available', () => {
    expect(pickI2iMode([backend('external'), backend('codex'), backend('local')]))
      .toBe(IMAGE_GEN_MODE.LOCAL);
  });

  it('falls back to codex when local is absent', () => {
    expect(pickI2iMode([backend('external'), backend('codex')])).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('returns null when neither i2i backend is installed', () => {
    expect(pickI2iMode([backend('external')])).toBeNull();
    expect(pickI2iMode([])).toBeNull();
  });
});

describe('deriveAvailableBackends', () => {
  it('includes only configured backends and respects excludeExternal', () => {
    const settings = {
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        codex: { enabled: true },
        external: { sdapiUrl: 'http://localhost:7860' },
      },
    };
    expect(deriveAvailableBackends(settings).map((b) => b.id))
      .toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.EXTERNAL]);
    expect(deriveAvailableBackends(settings, { excludeExternal: true }).map((b) => b.id))
      .toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX]);
    expect(deriveAvailableBackends(undefined)).toEqual([]);
  });
});
