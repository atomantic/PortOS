import { describe, it, expect } from 'vitest';
import { aspectCropSize } from './aspectConform.js';

// The crop-box arithmetic, over the shapes Codex actually returned for 16:9
// production stills. The end-to-end crop (sharp + sidecar) is covered in
// codex.test.js; this pins the tolerance boundary and both crop directions.
describe('aspectCropSize', () => {
  it.each([
    ['Codex 16:9 passes untouched', [1672, 941, 1920, 1080], null],
    ['square close-up crops height', [1254, 1254, 1920, 1080], { width: 1254, height: 705 }],
    ['near-4:3 crops height', [1448, 1086, 1920, 1080], { width: 1448, height: 815 }],
    ['3:2 crops height', [1536, 1024, 1920, 1080], { width: 1536, height: 864 }],
    ['too-wide frame crops width', [2000, 800, 1920, 1080], { width: 1422, height: 800 }],
    ['portrait request from a landscape frame', [1536, 1024, 1024, 1536], { width: 683, height: 1024 }],
    ['unusable size is left alone', [0, 1024, 1920, 1080], null],
    ['no requested size is left alone', [1254, 1254, null, null], null],
  ])('%s', (_label, [sw, sh, tw, th], expected) => {
    expect(aspectCropSize(sw, sh, tw, th)).toEqual(expected);
  });
});
