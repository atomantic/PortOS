import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure } from './staticImportGraph.js';
import * as limits from './referenceLimits.js';
import * as capabilities from './imageGenCapabilities.js';
import * as conditioning from './musicVideoConditioning.js';

const libDir = fileURLToPath(new URL('.', import.meta.url));
const closure = (file) => staticImportClosure(join(libDir, file)).files;

describe('shared reference limits', () => {
  it('keeps the original exports on the modules that used to own them', () => {
    expect(capabilities.IMAGE_REFERENCE_REQUEST_LIMIT).toBe(limits.IMAGE_REFERENCE_REQUEST_LIMIT);
    expect(conditioning.MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT).toBe(limits.MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT);
    expect(conditioning.MUSIC_VIDEO_MAX_REFERENCE_CHOICES).toBe(limits.IMAGE_REFERENCE_REQUEST_LIMIT);
  });

  it('lets the schema read the limits without loading the implementations that act on them', () => {
    const files = closure('musicVideoValidation.js');
    expect(files.has(join(libDir, 'referenceLimits.js'))).toBe(true);
    expect(files.has(join(libDir, 'imageGenCapabilities.js'))).toBe(false);
    expect(files.has(join(libDir, 'musicVideoConditioning.js'))).toBe(false);
  });
});
