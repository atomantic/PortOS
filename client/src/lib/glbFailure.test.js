// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { glbErrorText, glbFailureHint } from './glbFailure';

describe('glbFailureHint', () => {
  // `null` is load-bearing: a caller shows the raw message only when nothing
  // here recognized the cause, so a generic catch-all string would hide that.
  it('only names a cause it can actually recognize', () => {
    expect(glbFailureHint(new Error('something went sideways'))).toBeNull();
    expect(glbFailureHint(new Error('<!DOCTYPE html>'))).toMatch(/web page/i);
    expect(glbFailureHint(new Error('responded with 404'))).toMatch(/no longer on disk/i);
    expect(glbFailureHint(new Error('Error creating WebGL context'))).toMatch(/WebGL/i);
  });

  // The reported failure shape: a server answering an asset path with the SPA
  // index, so the glTF parser JSON.parses HTML and blames a `<` token.
  it('recognizes an HTML body reaching the glTF parser', () => {
    const error = new Error(
      "Could not load /data/image-to-3d/abc/model.glb: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    );
    expect(glbFailureHint(error)).toMatch(/web page instead of the mesh file/i);
  });
});

describe('glbErrorText', () => {
  it('reads a message off whatever shape the thrower used', () => {
    expect(glbErrorText(new Error('boom'))).toBe('boom');
    expect(glbErrorText('plain string')).toBe('plain string');
    expect(glbErrorText(null)).toBe('');
    expect(glbErrorText(undefined)).toBe('');
  });
});
