import { describe, it, expect } from 'vitest';
import {
  classifySafetyKind,
  requiresSafetyApproval,
  REVERSIBLE_SAFETY_KIND,
  OUTWARD_SAFETY_KINDS,
  DEFAULT_ALWAYS_APPROVE_KINDS
} from './safetyKind.js';

// Pure classifier for the safety-kind override (#2440). Confidence gates on
// success rate; safety-kind gates on whether the work is outward-facing /
// irreversible. Every branch is exercised directly — no I/O.

describe('classifySafetyKind (#2440)', () => {
  it('defaults internal improvement work to reversible', () => {
    for (const key of ['self-improve:code-review', 'app-improve:dependency-audit', 'self-improve:refactor', 'internal']) {
      const out = classifySafetyKind({ taskTypeKey: key, metadata: { analysisType: 'refactor' } });
      expect(out.kind).toBe(REVERSIBLE_SAFETY_KIND);
      expect(out.outwardFacing).toBe(false);
    }
  });

  it('returns reversible for empty/no input', () => {
    expect(classifySafetyKind().kind).toBe(REVERSIBLE_SAFETY_KIND);
    expect(classifySafetyKind({}).outwardFacing).toBe(false);
    expect(classifySafetyKind({ metadata: null }).kind).toBe(REVERSIBLE_SAFETY_KIND);
  });

  it('honors an explicit metadata.safetyKind override (outward)', () => {
    const out = classifySafetyKind({ taskTypeKey: 'self-improve:refactor', metadata: { safetyKind: 'Content' } });
    expect(out.kind).toBe('content'); // normalized lowercase
    expect(out.outwardFacing).toBe(true);
    expect(out.reason).toContain('explicit');
  });

  it('treats an explicit but unknown safetyKind as reversible (not in outward set)', () => {
    const out = classifySafetyKind({ metadata: { safetyKind: 'proposal-draft' } });
    expect(out.kind).toBe('proposal-draft');
    expect(out.outwardFacing).toBe(false);
  });

  it('honors metadata.outwardFacing boolean flags in both directions', () => {
    expect(classifySafetyKind({ metadata: { outwardFacing: true } }).outwardFacing).toBe(true);
    // outwardFacing:false wins even when a keyword signature would otherwise fire
    const forced = classifySafetyKind({ taskTypeKey: 'publish:blog', metadata: { outwardFacing: false } });
    expect(forced.kind).toBe(REVERSIBLE_SAFETY_KIND);
    expect(forced.outwardFacing).toBe(false);
  });

  it('classifies boolean capability hints', () => {
    expect(classifySafetyKind({ metadata: { federatesRecords: true } }).kind).toBe('federation');
    expect(classifySafetyKind({ metadata: { publishesToPeers: true } }).kind).toBe('federation');
    expect(classifySafetyKind({ metadata: { publishesContent: true } }).kind).toBe('content');
    expect(classifySafetyKind({ metadata: { opensExternalPr: true } }).kind).toBe('external-pr');
  });

  it('classifies via keyword signatures on the task-type key / description', () => {
    expect(classifySafetyKind({ taskTypeKey: 'app-improve:federate-records' }).kind).toBe('federation');
    expect(classifySafetyKind({ taskTypeKey: 'open-upstream-pr' }).kind).toBe('external-pr');
    expect(classifySafetyKind({ taskTypeKey: 'publish-release' }).kind).toBe('publish');
    expect(classifySafetyKind({ metadata: { taskDescription: 'Deploy the site to production' } }).kind).toBe('publish');
    expect(classifySafetyKind({ metadata: { taskDescription: 'Draft a social-media post' } }).kind).toBe('content');
  });

  it('all outward classifications set outwardFacing true; reversible sets false', () => {
    const outward = classifySafetyKind({ taskTypeKey: 'auto-send-outbound-message' });
    expect(outward.outwardFacing).toBe(true);
    expect(OUTWARD_SAFETY_KINDS).toContain(outward.kind);
  });
});

describe('requiresSafetyApproval (#2440)', () => {
  it('forces approval for every default outward kind', () => {
    for (const kind of DEFAULT_ALWAYS_APPROVE_KINDS) {
      expect(requiresSafetyApproval(kind)).toBe(true);
    }
  });

  it('does not force approval for reversible internal work', () => {
    expect(requiresSafetyApproval(REVERSIBLE_SAFETY_KIND)).toBe(false);
  });

  it('is case-insensitive on both the kind and the config list', () => {
    expect(requiresSafetyApproval('CONTENT')).toBe(true);
    expect(requiresSafetyApproval('content', { alwaysApproveKinds: ['CONTENT'] })).toBe(true);
  });

  it('respects a custom alwaysApproveKinds list', () => {
    const config = { alwaysApproveKinds: ['content'] };
    expect(requiresSafetyApproval('content', config)).toBe(true);
    expect(requiresSafetyApproval('federation', config)).toBe(false); // removed from list
  });

  it('returns false when the safety gate is disabled', () => {
    expect(requiresSafetyApproval('content', { enabled: false })).toBe(false);
  });

  it('falls back to defaults for a non-array / missing list', () => {
    expect(requiresSafetyApproval('federation', { alwaysApproveKinds: 'not-an-array' })).toBe(true);
    expect(requiresSafetyApproval('federation', {})).toBe(true);
  });

  it('returns false for an empty/blank kind', () => {
    expect(requiresSafetyApproval('')).toBe(false);
    expect(requiresSafetyApproval(null)).toBe(false);
  });
});

describe('safety-kind override branch (#2440) — composed decision', () => {
  // Mirrors resolveConfidenceApproval()'s override branch: an outward-facing
  // task is force-approved BEFORE (and regardless of) the confidence tier — even
  // a 100%-success task type. Reversible work falls through to the confidence gate.
  const wouldForceApproval = ({ taskTypeKey, metadata }, safetyConfig) => {
    const safety = classifySafetyKind({ taskTypeKey, metadata });
    return safety.outwardFacing && requiresSafetyApproval(safety.kind, safetyConfig);
  };

  it('overrides a would-be auto-approval for outward work regardless of confidence', () => {
    // Even if confidence tier is "high" (100% success), the safety override wins.
    expect(wouldForceApproval({ taskTypeKey: 'publish-release' }, {})).toBe(true);
    expect(wouldForceApproval({ metadata: { federatesRecords: true } }, {})).toBe(true);
  });

  it('leaves reversible internal tasks to the confidence gate (no override)', () => {
    expect(wouldForceApproval({ taskTypeKey: 'self-improve:code-review' }, {})).toBe(false);
  });

  it('lets the user disable the safety override entirely', () => {
    expect(wouldForceApproval({ taskTypeKey: 'publish-release' }, { enabled: false })).toBe(false);
  });
});
