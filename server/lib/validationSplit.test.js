import { describe, it, expect } from 'vitest';
import * as validation from './validation.js';
import * as peerSyncValidation from './peerSyncValidation.js';
import * as creativeDirectorValidation from './creativeDirectorValidation.js';
import * as storyBuilderValidation from './storyBuilderValidation.js';

// Issue #1151 split validation.js's peer-sync / creative-director / story-
// builder schema groups into per-domain files, with validation.js re-exporting
// them so existing deep imports keep working. This pins that transitional
// contract: every moved export must remain reachable from validation.js AND
// be the SAME object as the domain file's export (not a divergent copy).
describe('validation.js transitional re-exports (issue #1151)', () => {
  const domains = [
    ['peerSyncValidation', peerSyncValidation],
    ['creativeDirectorValidation', creativeDirectorValidation],
    ['storyBuilderValidation', storyBuilderValidation],
  ];

  it.each(domains)('%s exports are all reachable from validation.js as the same objects', (_name, mod) => {
    for (const [key, value] of Object.entries(mod)) {
      expect(validation[key], `validation.js re-export of '${key}'`).toBe(value);
    }
  });

  it('the moved schemas still parse through the validation.js entry', () => {
    expect(() => validation.validateRequest(validation.peerSubscribeSchema, {
      peerId: 'peer-1', recordKind: 'universe', recordId: 'u-1',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.storySessionCreateSchema, {
      title: 'My Story',
    })).not.toThrow();
    expect(validation.IMPORTER_CONTENT_TYPES).toBeDefined();
  });

  it('cross-cutting primitives stayed in validation.js', () => {
    expect(typeof validation.validateRequest).toBe('function');
    expect(typeof validation.parsePagination).toBe('function');
    expect(validation.llmSchema).toBeDefined();
    expect(typeof validation.emptyToUndefined).toBe('function');
  });
});
