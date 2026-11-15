/**
 * The prompt-integrity bump tool (#6480).
 *
 * `integrity.snapshot.json` is the only record of the defaults a key has
 * retired: promptMatchesShippedDefault recognizes a stored prompt as shipped by
 * hashing it against that history, and the retired bodies themselves are not
 * in the tree. So the history has exactly one writer — this tool, which moves
 * the committed CURRENT hash onto the history whenever it bumps a key's version
 * (the snapshot owns the version numbers).
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
// The source's PROMPT_VERSIONS is ignored by the tool — the committed snapshot owns versions.
const source = ({ audit = 'audit v1 body', stage = 'stage body', auditVersion = 1 } = {}) => ({
  DEFAULT_TASK_PROMPTS: { audit, 'pipeline-stage': stage },
  PROMPT_VERSIONS: { audit: auditVersion },
  REFERENCE_WATCH_AUDITED_VERSION: 3,
  UNPERSISTED_PROMPT_KEYS: ['pipeline-stage'],
});
const committedFor = (defaults, history = {}) => ({
  ...buildPromptIntegritySnapshot(defaults),
  PREVIOUS_DEFAULT_PROMPTS: history,
});
const V1 = hashPromptBody('audit v1 body');
const V2 = hashPromptBody('audit v2 body');

describe('advancePromptIntegritySnapshot', () => {
  it('bumps the version itself and retires the outgoing hash when the body changed', () => {
    const { snapshot, retired, added, dropped } = advancePromptIntegritySnapshot(
      committedFor(source()),
      source({ audit: 'audit v2 body' }),
    );

    expect({ added, dropped }).toEqual({ added: [], dropped: [] });
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
    const { snapshot } = advancePromptIntegritySnapshot(committed, source({ audit: 'audit v3 body' }));
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS.audit).toEqual([V1, V2]);
    expect(snapshot.PROMPT_VERSIONS.audit).toBe(3);
  });

  it('lets an unversioned stage body follow the source with no bump and no history', () => {
    const { snapshot, retired } = advancePromptIntegritySnapshot(
      committedFor(source()),
      source({ stage: 'stage body, edited' }),
    );
    expect(retired).toEqual([]);
    expect(snapshot.DEFAULT_TASK_PROMPTS['pipeline-stage']).toBe(hashPromptBody('stage body, edited'));
    expect(snapshot.PROMPT_VERSIONS).toEqual({ audit: 1 });
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({});
  });

  it('starts a new persisted prompt at v1 and leaves a new unpersisted body unversioned', () => {
    const defaults = source();
    const withNew = {
      ...defaults,
      DEFAULT_TASK_PROMPTS: { ...defaults.DEFAULT_TASK_PROMPTS, fresh: 'fresh body', 'other-stage': 'stage two' },
      UNPERSISTED_PROMPT_KEYS: ['pipeline-stage', 'other-stage'],
    };
    const { snapshot, added, retired } = advancePromptIntegritySnapshot(committedFor(defaults), withNew);
    expect(added).toEqual([{ key: 'fresh', to: 1 }]);
    expect(retired).toEqual([]);
    expect(snapshot.PROMPT_VERSIONS).toEqual({ audit: 1, fresh: 1 });
  });

  it('drops the history of a key that is no longer versioned', () => {
    const committed = committedFor(source({ audit: 'audit v2 body', auditVersion: 2 }), { audit: [V1], retired: ['0'.repeat(32)] });
    const { snapshot, dropped } = advancePromptIntegritySnapshot(committed, source({ audit: 'audit v2 body' }));
    expect(dropped).toEqual(['retired']);
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({ audit: [V1] });
  });

  it('moves current and retired hashes and the version with a renamed prompt key', () => {
    const oldBody = 'old lifecycle body';
    const oldCurrent = hashPromptBody(oldBody);
    const oldRetired = 'a'.repeat(32);
    const renamedSource = {
      DEFAULT_TASK_PROMPTS: { 'ui-lifecycle': 'new lifecycle body' },
      PROMPT_VERSIONS: {},
      REFERENCE_WATCH_AUDITED_VERSION: 3,
    };
    const committed = {
      ...buildPromptIntegritySnapshot({
        DEFAULT_TASK_PROMPTS: { 'react-lifecycle': oldBody },
        PROMPT_VERSIONS: { 'react-lifecycle': 2 },
        REFERENCE_WATCH_AUDITED_VERSION: 3,
      }),
      PREVIOUS_DEFAULT_PROMPTS: { 'react-lifecycle': [oldRetired] },
    };

    const { snapshot, dropped } = advancePromptIntegritySnapshot(committed, renamedSource);

    expect(dropped).toEqual([]);
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).toEqual({ 'ui-lifecycle': [oldRetired, oldCurrent] });
    expect(snapshot.PREVIOUS_DEFAULT_PROMPTS).not.toHaveProperty('react-lifecycle');
  });

  it('is a no-op on an unchanged source, byte for byte', () => {
    const committed = committedFor(source({ audit: 'audit v2 body', auditVersion: 2 }), { audit: [V1] });
    const { snapshot, retired, added, dropped } = advancePromptIntegritySnapshot(committed, source({ audit: 'audit v2 body' }));
    expect({ retired, added, dropped }).toEqual({ retired: [], added: [], dropped: [] });
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(committed));
  });
});

describe('regen-prompt-integrity-snapshot CLI', () => {
  const committed = readPromptIntegritySnapshot();
  const key = Object.keys(committed.PREVIOUS_DEFAULT_PROMPTS)[0];
  let log;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // The committed snapshot must be exactly what the tool derives from the
  // current source — a body edit whose author skipped the regen surfaces here
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
});
