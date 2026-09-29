import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VIDEO_STREAMING_MODES } from '../../lib/videoStreamingMode.js';
import { MUSCRIPTOR_MODELS } from '../../lib/muscriptorModels.js';
import { FASTVIDEO_FAMILIES } from './renderArgs.js';

// These value sets are declared in a Python helper's argparse `choices=` (the
// helper must run standalone) and again in JS. Pin each pair so adding or
// renaming a value on one side fails here, not at render time with argparse
// exit code 2.
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts');
const strings = (text) => [...text.matchAll(/["']([^"']+)["']/g)].map(([, v]) => v);
const read = (name) => readFileSync(join(scriptsDir, name), 'utf8');

describe('Python argparse choices match their JS exports', () => {
  it('LTX-2 streaming modes', () => {
    const m = read('generate_ltx2.py').match(/^STREAMING_MODE_CHOICES = \(([^)]*)\)/m);
    expect(m).not.toBeNull();
    expect(strings(m[1])).toEqual([...VIDEO_STREAMING_MODES]);
  });

  it('FastVideo families', () => {
    const m = read('generate_fastvideo.py').match(/"--family",\s*choices=\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(strings(m[1])).toEqual([...FASTVIDEO_FAMILIES]);
  });

  it('MuScriptor model sizes', () => {
    const m = read('transcribe_muscriptor.py').match(/"--model",\s*default="[^"]*",\s*choices=\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    expect(strings(m[1])).toEqual([...MUSCRIPTOR_MODELS]);
  });
});
