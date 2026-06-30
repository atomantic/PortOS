import { describe, it, expect } from 'vitest';
import * as validation from './validation.js';
import * as peerSyncValidation from './peerSyncValidation.js';
import * as creativeDirectorValidation from './creativeDirectorValidation.js';
import * as storyBuilderValidation from './storyBuilderValidation.js';
import * as agentValidation from './agentValidation.js';
import * as cosValidation from './cosValidation.js';
import * as mediaValidation from './mediaValidation.js';
import * as pipelineValidation from './pipelineValidation.js';

// Issues #1151 and #1831 split validation.js's domain schema groups into per-
// domain files, with validation.js re-exporting them so existing deep imports
// keep working. This pins that transitional contract: every moved export must
// remain reachable from validation.js AND be the SAME object as the domain
// file's export (not a divergent copy).
describe('validation.js transitional re-exports (issues #1151, #1831)', () => {
  const domains = [
    // #1151
    ['peerSyncValidation', peerSyncValidation],
    ['creativeDirectorValidation', creativeDirectorValidation],
    ['storyBuilderValidation', storyBuilderValidation],
    // #1831
    ['agentValidation', agentValidation],
    ['cosValidation', cosValidation],
    ['mediaValidation', mediaValidation],
    ['pipelineValidation', pipelineValidation],
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

  it('#1831 moved schemas + non-schema exports are wired through the validation.js entry', () => {
    // One parse-smoke per new domain — proves the schema is reachable AND
    // usable through the validation.js entry (mirrors the #1151 block above).
    expect(() => validation.validateRequest(validation.agentSchema, {
      userId: 'u1', name: 'Botley', personality: { style: 'witty' },
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.createCosTaskSchema, {
      description: 'do the thing',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.localLlmInstallSchema, {
      backend: 'ollama', modelId: 'llama3',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.writersRoomWorkCreateSchema, {
      title: 'My Work',
    })).not.toThrow();
    // Non-schema exports (a function + a constant) must also re-export — the
    // "same objects" test covers identity, this confirms barrel reachability
    // for the kinds of exports that aren't Zod schemas.
    expect(typeof validation.normalizeReviewers).toBe('function');
    expect(validation.MAX_CONVERGENCE_ROUNDS).toBe(20);
  });

  it('cross-cutting primitives stayed in validation.js', () => {
    expect(typeof validation.validateRequest).toBe('function');
    expect(typeof validation.validate).toBe('function');
    expect(typeof validation.parsePagination).toBe('function');
    expect(typeof validation.optionalBooleanMap).toBe('function');
    expect(typeof validation.isSafeRecordId).toBe('function');
    expect(validation.llmSchema).toBeDefined();
    expect(typeof validation.emptyToUndefined).toBe('function');
  });

  it('the new #1831 domain files do NOT import back from validation.js (cycle guard)', () => {
    for (const mod of [agentValidation, cosValidation, mediaValidation, pipelineValidation]) {
      // validateRequest / parsePagination live only in validation.js — if a
      // domain file re-imported the barrel they'd leak through `export *`.
      expect(mod.validateRequest).toBeUndefined();
      expect(mod.parsePagination).toBeUndefined();
    }
  });
});
