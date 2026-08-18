import { describe, expect, it } from 'vitest';
import { buildThreejsAnimationFeedback, summarizeThreejsAnimation } from './threejsModelAnimation.js';

const clip = (overrides = {}) => ({
  id: 'deploy',
  name: 'Deploy',
  role: 'deploy',
  durationSeconds: 3,
  loop: false,
  sequences: [
    {
      id: 'lift',
      name: 'Lift',
      partId: 'panel',
      startSeconds: 0,
      endSeconds: 1,
      easing: 'easeOut',
      channels: { position: { from: [0, 0, 0], to: [0, 1, 0] } },
      cueId: 'latch',
    },
    {
      id: 'swing',
      name: 'Swing',
      partId: 'arm',
      startSeconds: 1,
      endSeconds: 2,
      easing: 'linear',
      channels: { rotationDegrees: { from: [0, 0, 0], to: [0, 90, 0] } },
      cueId: 'latch',
    },
  ],
  ...overrides,
});

describe('summarizeThreejsAnimation', () => {
  it('reports a spec with no animation key as a static assembly, never as evaluated-and-empty', () => {
    for (const spec of [null, undefined, {}, { animation: null }]) {
      expect(summarizeThreejsAnimation(spec)).toMatchObject({
        animated: false,
        clipCount: 0,
        sequenceCount: 0,
        movingPartCount: 0,
        longestClipSeconds: 0,
      });
    }
  });

  it('counts clips, sequences, distinct moving parts, and the longest authored window', () => {
    const summary = summarizeThreejsAnimation({
      animation: {
        cues: [{ id: 'latch', label: 'Latch', kind: 'latch' }],
        clips: [clip(), clip({ id: 'retract', name: 'Retract', role: 'retract', durationSeconds: 5 })],
      },
    });
    expect(summary).toMatchObject({
      animated: true,
      clipCount: 2,
      cueCount: 1,
      sequenceCount: 4,
      // Two parts across four sequences — the same part in two clips is one part.
      movingPartCount: 2,
      longestClipSeconds: 5,
    });
    expect(summary.clips[0]).toEqual({
      id: 'deploy',
      name: 'Deploy',
      role: 'deploy',
      durationSeconds: 3,
      sequenceCount: 2,
      // One cue fired by two sequences is one sound the host has to supply.
      cueCount: 1,
    });
  });

  it('reports the authored duration, not the last sequence end, so a held final pose counts', () => {
    const summary = summarizeThreejsAnimation({ animation: { clips: [clip({ durationSeconds: 8 })] } });
    expect(summary.longestClipSeconds).toBe(8);
  });

  it('defaults a clip that arrived without a role rather than printing undefined', () => {
    const summary = summarizeThreejsAnimation({ animation: { clips: [clip({ role: undefined })] } });
    expect(summary.clips[0].role).toBe('custom');
  });
});

// Parts the fixture clip drives, in the pose the assembly builds — so a test
// that expects a clean gate is starting from a model that really does open
// where its clip does.
const parts = () => ([
  { id: 'panel', name: 'Panel', position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1], children: [] },
  { id: 'arm', name: 'Arm', position: [1, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1], children: [] },
]);

const animatedSpec = (overrides = {}) => ({
  parts: parts(),
  animation: {
    cues: [{ id: 'latch', label: 'Latch', kind: 'latch' }],
    clips: [clip()],
  },
  ...overrides,
});

const codesOf = (spec) => summarizeThreejsAnimation(spec).findings.map((finding) => finding.code);

describe('summarizeThreejsAnimation playback findings', () => {
  it('reports nothing for a clip authored against the pose the assembly builds', () => {
    const summary = summarizeThreejsAnimation(animatedSpec());
    expect(summary.findings).toEqual([]);
    expect(summary.warningCount).toBe(0);
  });

  it('flags a clip that opens somewhere the assembly does not build, naming the part and both poses', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].sequences[0].channels.position.from = [0, 5, 0];
    const [finding] = summarizeThreejsAnimation(spec).findings;
    expect(finding).toMatchObject({ code: 'clip-start-pose-mismatch', severity: 'warning' });
    expect(finding.message).toContain('Panel.position opens at [0, 5, 0] but the assembly builds it at [0, 0, 0]');
  });

  it('tolerates float drift in an authored endpoint rather than reporting a jump nobody can see', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].sequences[0].channels.position.from = [0, 1e-9, 0];
    expect(codesOf(spec)).toEqual([]);
  });

  it('flags a handover between two sequences on one channel that do not meet', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].sequences.push({
      id: 'lower',
      name: 'Lower',
      partId: 'panel',
      startSeconds: 1,
      endSeconds: 2,
      easing: 'linear',
      // The lift ended at [0, 1, 0]; this restarts the panel a metre away.
      channels: { position: { from: [0, 2, 0], to: [0, 0, 0] } },
      cueId: null,
    });
    const finding = summarizeThreejsAnimation(spec).findings.find((entry) => entry.code === 'clip-sequence-jump');
    expect(finding.message).toContain('ends lift at [0, 1, 0] and starts lower at [0, 2, 0]');
  });

  it('flags a looping clip that does not return to where it began', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].loop = true;
    const finding = summarizeThreejsAnimation(spec).findings.find((entry) => entry.code === 'loop-does-not-close');
    expect(finding.message).toContain('Panel.position ends at [0, 1, 0] and restarts at [0, 0, 0]');
  });

  it('accepts a looping clip whose channels close back onto their opening pose', () => {
    const spec = animatedSpec();
    const [lift] = spec.animation.clips[0].sequences;
    spec.animation.clips[0].loop = true;
    spec.animation.clips[0].durationSeconds = 2;
    spec.animation.clips[0].sequences = [
      lift,
      {
        ...lift,
        id: 'lower',
        name: 'Lower',
        startSeconds: 1,
        endSeconds: 2,
        channels: { position: { from: [0, 1, 0], to: [0, 0, 0] } },
      },
    ];
    expect(codesOf(spec)).toEqual([]);
  });

  it('flags an idle authored as a one-shot, which plays once and freezes', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].role = 'idle';
    expect(codesOf(spec)).toContain('idle-clip-does-not-loop');
  });

  it('flags a declared cue no sequence ever fires', () => {
    const spec = animatedSpec();
    spec.animation.cues.push({ id: 'servo', label: 'Servo whine', kind: 'servo' });
    const finding = summarizeThreejsAnimation(spec).findings.find((entry) => entry.code === 'unfired-cue');
    expect(finding.message).toContain('Servo whine');
  });

  it('flags a clip that finishes early and then holds still for most of its window', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].durationSeconds = 20;
    const finding = summarizeThreejsAnimation(spec).findings.find((entry) => entry.code === 'clip-holds-still');
    expect(finding.message).toContain('finishes moving at 2s and then holds still for 18s of its 20s duration');
  });

  it('leaves a clip that holds its final pose briefly alone', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].durationSeconds = 3;
    expect(codesOf(spec)).toEqual([]);
  });

  it('flags an articulation graph no clip demonstrates, and leaves a plain static assembly alone', () => {
    const articulated = {
      parts: parts(),
      articulation: {
        joints: [
          { id: 'root', partId: 'panel' },
          { id: 'elbow', partId: 'arm', parentJointId: 'root', pivotSocket: 'elbow' },
        ],
      },
    };
    expect(codesOf(articulated)).toEqual(['articulation-without-clips']);
    // A static object declares no joints, so nothing here pushes every model
    // toward motion it never showed.
    expect(codesOf({ parts: parts() })).toEqual([]);
    expect(codesOf({ parts: parts(), articulation: { joints: [{ id: 'root', partId: 'panel' }] } })).toEqual([]);
  });
});

describe('buildThreejsAnimationFeedback', () => {
  it('returns nothing for a record with no findings, and for one written before the gate shipped', () => {
    expect(buildThreejsAnimationFeedback(summarizeThreejsAnimation(animatedSpec()))).toBe('');
    for (const stored of [null, undefined, {}, { animated: true, clipCount: 1 }]) {
      expect(buildThreejsAnimationFeedback(stored)).toBe('');
    }
  });

  it('numbers the warnings and states the contract a refinement has to satisfy', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].sequences[0].channels.position.from = [0, 5, 0];
    spec.animation.clips[0].role = 'idle';
    const feedback = buildThreejsAnimationFeedback(summarizeThreejsAnimation(spec));
    expect(feedback).toContain('1. clip Deploy is authored against a pose the assembly does not build');
    expect(feedback).toContain('2. clip Deploy is an idle but does not loop');
    expect(feedback).toContain('the first sequence on a part starts from exactly the position');
  });

  it('reads findings off the stored record rather than re-deriving them from a spec', () => {
    const feedback = buildThreejsAnimationFeedback({
      findings: [
        { code: 'loop-does-not-close', severity: 'warning', message: 'clip Idle snaps on every repeat' },
        { code: 'made-up', severity: 'note', message: 'not actionable' },
      ],
    });
    expect(feedback).toContain('1. clip Idle snaps on every repeat');
    expect(feedback).not.toContain('not actionable');
  });
});
