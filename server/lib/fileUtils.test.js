import { describe, it, expect } from 'vitest';
import * as facade from './fileUtils.js';
import * as fileCore from './fileCore.js';
import * as jsonIo from './jsonIo.js';
import * as mimeTypes from './mimeTypes.js';
import * as paths from './paths.js';
import * as pathSafety from './pathSafety.js';
import * as uploads from './uploads.js';

describe('fileUtils facade', () => {
  it('re-exports remaining leaf module exports unchanged', () => {
    for (const leaf of [fileCore, jsonIo, paths, pathSafety]) {
      for (const [name, value] of Object.entries(leaf)) {
        expect(facade[name], name).toBe(value);
      }
    }
  });

  it('no longer re-exports mimeTypes or uploads (#16904)', () => {
    for (const leaf of [mimeTypes, uploads]) {
      for (const name of Object.keys(leaf)) {
        expect(facade[name], name).toBeUndefined();
      }
    }
  });
});
