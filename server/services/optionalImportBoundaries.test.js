import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure } from '../lib/staticImportGraph.js';

// Optional music-video and agent workflows load where they run, so a caller that
// never uses them does not parse and evaluate their module graphs (#14867).
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const closure = (file) => staticImportClosure(join(serverDir, file)).files;
const reaches = (entry, target) => closure(entry).has(join(serverDir, target));

describe('optional workflow import boundaries', () => {
  it.each([
    ['routes/signal.js', 'lib/musicVideoValidation.js'],
    ['services/musicVideo/lyricAlign.js', 'services/musicVideo/vocalStem.js'],
    ['services/musicVideo/lyricAlignCore.js', 'services/musicVideo/vocalStem.js'],
    ['services/musicVideo/vocalSeparation.js', 'services/musicVideo/vocalStem.js'],
    ['services/cosAgentHistory.js', 'services/cosAgentLifecycle.js'],
    ['services/cosAgentHistory.js', 'services/cosAgentIndex.js'],
  ])('%s does not statically reach %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  it('keeps positive controls: the stem storage and validation modules are real graphs', () => {
    expect(reaches('services/musicVideo/vocalStem.js', 'services/musicVideo/projects.js')).toBe(true);
    expect(reaches('lib/validation.js', 'lib/musicVideoValidation.js')).toBe(true);
  });
});
