/**
 * The prompt-integrity bump tool (#6480).
 *
 * `integrity.snapshot.json` is the only record of the defaults a key has
 * retired: promptMatchesShippedDefault recognizes a stored prompt as shipped by
 * hashing it against that history, and the retired bodies themselves are not
 * in the tree. So the history has exactly one writer — this tool, which moves
 * the committed CURRENT hash onto the history whenever PROMPT_VERSIONS rises.
 * These pin that contract on the pure core (against a synthetic catalog) and
 * on the CLI's exit code and write (in-process, against the committed snapshot
 * — which is read, never written).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  advancePromptIntegritySnapshot,
  buildPromptIntegritySnapshot,
  hashPromptBody,
  readPromptIntegritySnapshot,
} from '../server/services/taskPromptDefaults/integrityHash.js';
import { runCli } from './regen-prompt-integrity-snapshot.js';

// A miniature catalog: one versioned schedule prompt, one unversioned stage body.
const source = ({ audit = 'audit v1 body', stage = 'stage body', auditVersion = 1 } = {}) => ({
  DEFAULT_TASK_PROMPTS: { audit, 'pipeline-stage': stage },
  PROMPT_VERSIONS: { audit: auditVersion },
  REFERENCE_WATCH_AUDITED_VERSION: 3,
});
const committedFor = (defaults, history = {}) => ({
  ...buildPromptIntegritySnapshot(defaults),
  PREVIOUS_DEFAULT_PROMPTS: history,
});
const V1 = hashPromptBody('audit v1 body');
const V2 = hashPromptBody('audit v2 body');

describe('advancePromptIntegritySnapshot', () => {
  it('retires the outgoing hash onto the history when PROMPT_VERSIONS rises with the body', () => {
    const { snapshot, retired, drift, dropped } = advancePromptIntegritySnapshot(
      committedFor(source()),
      source({ audit: 'audit v2 body', auditVersion: 2 }),
    );

    expect({ drift, dropped }).toEqual({ drift: [], dropped: [] });
    expect(retired).toEqual([{ key: 'audit', from: 1, to: 2, hash: V1 }]);
    expect(snapshot).toEqual({
      DEFAULT_TASK_PROMPTS: { audit: V2, 'pipeline-stage': hashPromptBody('stage body') },
      PROMPT_VERSIONS: { audit: 2 },
      REFERENCE_WATCH_AUDITED_VERSION: 3,
      PREVIOUS_DEFAULT_PROMPTS: { audit: [V1] },
    });
  });

  it('appends behind the existing history, in ship order', () => {
    const committed = committedFor(source({ audit: 'audit v2 body', auditVersion: 2 }), { audit: [V1] });
    const { snapshot } = advancePromptIntegritySnapshot(committed, source({ audit: 'audit v3 body', auditVersion: 3 }));
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS.audit).toEqual([V1, V2]);
  });

  it('reports a versioned body that changed with no bump as drift, retiring nothing', () => {
    const { snapshot, retired, drift } = advancePromptIntegritySnapshot(
      committedFor(source()),
      source({ audit: 'audit v1 body, edited' }),
    );
    expect(drift).toEqual([{ key: 'audit', version: 1, reason: 'unbumped' }]);
    expect(retired).toEqual([]);
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({});
  });

  // A rollback freezes every install already stamped at the higher number: the
  // next real bump reads `storedVersion < current` as false there. So it is
  // drift even when the body is untouched, and reported once when it is not.
  it('reports a version that went backwards as drift, with or without a body change', () => {
    const committed = committedFor(source({ audit: 'audit v2 body', auditVersion: 2 }));
    expect(advancePromptIntegritySnapshot(committed, source({ audit: 'audit v2 body', auditVersion: 1 })).drift)
      .toEqual([{ key: 'audit', version: 1, reason: 'rollback' }]);
    expect(advancePromptIntegritySnapshot(committed, source({ audit: 'audit v1 body', auditVersion: 1 })).drift)
      .toEqual([{ key: 'audit', version: 1, reason: 'rollback' }]);
  });

  it('lets an unversioned stage body follow the source with no bump and no history', () => {
    const { snapshot, retired, drift } = advancePromptIntegritySnapshot(
      committedFor(source()),
      source({ stage: 'stage body, edited' }),
    );
    expect({ retired, drift }).toEqual({ retired: [], drift: [] });
    expect(snapshot.DEFAULT_TASK_PROMPTS['pipeline-stage']).toBe(hashPromptBody('stage body, edited'));
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({});
  });

  it('retires nothing for a bump that left the body alone', () => {
    const { snapshot, retired, drift } = advancePromptIntegritySnapshot(committedFor(source()), source({ auditVersion: 2 }));
    expect({ retired, drift }).toEqual({ retired: [], drift: [] });
    expect(snapshot.PROMPT_VERSIONS).toEqual({ audit: 2 });
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({});
  });

  it('drops the history of a key that is no longer versioned', () => {
    const committed = committedFor(source({ audit: 'audit v2 body', auditVersion: 2 }), { audit: [V1], retired: ['0'.repeat(32)] });
    const { snapshot, dropped } = advancePromptIntegritySnapshot(committed, source({ audit: 'audit v2 body', auditVersion: 2 }));
    expect(dropped).toEqual(['retired']);
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({ audit: [V1] });
  });

  it('is a no-op on an unchanged source, byte for byte', () => {
    const committed = committedFor(source({ audit: 'audit v2 body', auditVersion: 2 }), { audit: [V1] });
    const { snapshot, retired, drift, dropped } = advancePromptIntegritySnapshot(committed, source({ audit: 'audit v2 body', auditVersion: 2 }));
    expect({ retired, drift, dropped }).toEqual({ retired: [], drift: [], dropped: [] });
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(committed));
  });
});

describe('regen-prompt-integrity-snapshot CLI', () => {
  const committed = readPromptIntegritySnapshot();
  const key = Object.keys(committed.PREVIOUS_DEFAULT_PROMPTS)[0];
  let log;
  let error;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // The committed snapshot must be exactly what the tool derives from the
  // current source — a bump whose author skipped the second step surfaces here
  // as well as in taskPromptDefaults.test.js.
  it('reports the committed snapshot as current and writes nothing', () => {
    const write = vi.fn();
    expect(runCli({ read: () => committed, write })).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('already current');
  });

  it('moves the old current hash onto the history when the source is one bump ahead', () => {
    // Rewind ONE key so the real source reads as "bumped since": the rewound
    // current hash is a stand-in for the retired body, one version below.
    const standIn = 'stand-in-for-the-retired-body';
    const rewound = {
      ...committed,
      DEFAULT_TASK_PROMPTS: { ...committed.DEFAULT_TASK_PROMPTS, [key]: standIn },
      PROMPT_VERSIONS: { ...committed.PROMPT_VERSIONS, [key]: committed.PROMPT_VERSIONS[key] - 1 },
    };
    const write = vi.fn();
    expect(runCli({ read: () => rewound, write })).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain(`${key}: v${committed.PROMPT_VERSIONS[key] - 1} → v${committed.PROMPT_VERSIONS[key]}, retired ${standIn}`);

    const { PREVIOUS_DEFAULT_PROMPTS: writtenHistory, ...writtenSource } = JSON.parse(write.mock.calls[0][0]);
    const { PREVIOUS_DEFAULT_PROMPTS: committedHistory, ...committedSource } = committed;
    expect(writtenSource).toEqual(committedSource);
    expect(writtenHistory).toEqual({ ...committedHistory, [key]: [...committedHistory[key], standIn] });
  });

  it('exits non-zero and writes nothing when a versioned body changed with no bump', () => {
    const edited = {
      ...committed,
      DEFAULT_TASK_PROMPTS: { ...committed.DEFAULT_TASK_PROMPTS, [key]: 'hash-of-a-body-edited-without-a-bump' },
    };
    const write = vi.fn();
    expect(runCli({ read: () => edited, write })).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('\n')).toContain(`${key}: the default body changed but PROMPT_VERSIONS is still v${committed.PROMPT_VERSIONS[key]}`);
  });
});
