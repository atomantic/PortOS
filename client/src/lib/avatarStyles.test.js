import { describe, it, expect } from 'vitest';
import { AVATAR_STYLES, AVATAR_STYLE_IDS, AVATAR_STYLE_LABELS, WEBGL_AVATAR_STYLE_IDS } from './avatarStyles';

describe('avatarStyles registry', () => {
  it('has a unique id for every style', () => {
    expect(new Set(AVATAR_STYLE_IDS).size).toBe(AVATAR_STYLES.length);
  });

  it('derives AVATAR_STYLE_LABELS with one entry per style', () => {
    expect(Object.keys(AVATAR_STYLE_LABELS).sort()).toEqual([...AVATAR_STYLE_IDS].sort());
    for (const style of AVATAR_STYLES) {
      expect(AVATAR_STYLE_LABELS[style.id]).toBe(style.label);
    }
  });

  it('derives WEBGL_AVATAR_STYLE_IDS from the webgl flag only', () => {
    for (const style of AVATAR_STYLES) {
      expect(WEBGL_AVATAR_STYLE_IDS.has(style.id)).toBe(style.webgl);
    }
  });

  it('excludes the 2D core canvas style from the WebGL set', () => {
    expect(WEBGL_AVATAR_STYLE_IDS.has('core')).toBe(false);
  });
});
