import { describe, it, expect } from 'vitest';
import * as facade from './fileUtils.js';
import * as fileCore from './fileCore.js';
import * as jsonIo from './jsonIo.js';
import * as mimeTypes from './mimeTypes.js';
import * as paths from './paths.js';
import * as pathSafety from './pathSafety.js';
import * as uploads from './uploads.js';

describe('fileUtils facade', () => {
  it('re-exports every leaf module export unchanged', () => {
    for (const leaf of [fileCore, jsonIo, mimeTypes, paths, pathSafety, uploads]) {
      for (const [name, value] of Object.entries(leaf)) {
        expect(facade[name], name).toBe(value);
      }
    }
  });
});
