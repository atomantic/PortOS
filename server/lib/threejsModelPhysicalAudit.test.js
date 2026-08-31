import { describe, expect, it } from 'vitest';
import {
  buildThreejsPhysicalAuditFeedback,
  evaluateThreejsPhysicalAudit,
} from './threejsModelPhysicalAudit.js';

describe('threejsModelPhysicalAudit', () => {
  it('returns clean result for null/empty spec', () => {
    const res = evaluateThreejsPhysicalAudit(null);
    expect(res).toEqual({
      findings: [],
      errorCount: 0,
      warningCount: 0,
      noteCount: 0,
      evaluatedPartCount: 0,
      evaluatedPoseCount: 0,
      unmeasuredAttachments: [],
    });
  });

  it('evaluates clean static model without findings', () => {
    const spec = {
      name: 'Clean Box',
      parts: [
        {
          id: 'base',
          name: 'Base',
          geometry: { type: 'box', width: 2, height: 1, depth: 2 },
          position: [0, 0.5, 0],
          children: [
            {
              id: 'top',
              name: 'Top',
              geometry: { type: 'sphere', radius: 0.5 },
              position: [0, 0.8, 0],
            },
          ],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.evaluatedPartCount).toBe(2);
    expect(res.evaluatedPoseCount).toBe(1);
    expect(res.errorCount).toBe(0);
    expect(res.warningCount).toBe(0);
    expect(res.findings).toEqual([]);
    expect(buildThreejsPhysicalAuditFeedback(res)).toBe('');
  });

  it('flags non-uniform parent scale and names the affected non-relief descendants', () => {
    const spec = {
      name: 'Scaled Parent Spec',
      parts: [
        {
          id: 'torso',
          name: 'Torso',
          geometry: { type: 'box', width: 2, height: 1, depth: 1 },
          position: [0, 0.5, 0],
          scale: [3, 1, 0.2],
          children: [
            {
              id: 'head',
              name: 'Head',
              geometry: { type: 'sphere', radius: 0.5 },
              position: [0, 1, 0],
            },
            {
              id: 'panel_lines',
              name: 'Panel Lines',
              explodeWithParent: true,
              geometry: { type: 'box', width: 1, height: 0.01, depth: 0.01 },
            },
          ],
        },
      ],
    };

    const res = evaluateThreejsPhysicalAudit(spec);
    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      severity: 'warning',
      partIds: ['torso', 'head'],
      affectedDescendantNames: ['Head'],
      anisotropyRatio: 15,
    });
    expect(finding.message).toContain('Torso');
    expect(finding.message).toContain('Head');
    expect(finding.message).toContain('anisotropy ratio 15.00');
    expect(buildThreejsPhysicalAuditFeedback(res)).toContain('box width/height/depth');
  });

  it('ignores relief-only children when a parent is deliberately non-uniform', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Relief Parent Spec',
      parts: [{
        id: 'blade',
        name: 'Blade',
        geometry: { type: 'box', width: 2, height: 0.2, depth: 1 },
        position: [0, 0.1, 0],
        scale: [4, 1, 0.5],
        children: [{
          id: 'serrations',
          name: 'Serrations',
          explodeWithParent: true,
          geometry: { type: 'box', width: 1, height: 0.1, depth: 0.1 },
        }],
      }],
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
  });

  it('traverses empty organizational groups but reports only geometry-bearing descendants', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Organizational Group Spec',
      parts: [{
        id: 'body',
        name: 'Body',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
        children: [{
          id: 'rig',
          name: 'Rig',
          children: [{
            id: 'head',
            name: 'Head',
            geometry: { type: 'sphere', radius: 0.5 },
          }],
        }],
      }],
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      partIds: ['body', 'head'],
      affectedDescendantNames: ['Head'],
    });
    expect(finding.message).not.toContain('Rig');
  });

  it('caps descendant names in feedback-sized finding messages', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Many Descendants Spec',
      parts: [{
        id: 'root',
        name: 'Root',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
        children: Array.from({ length: 9 }, (_, index) => ({
          id: `child-${index + 1}`,
          name: `Child ${index + 1}`,
          geometry: { type: 'sphere', radius: 0.1 },
        })),
      }],
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding.message).toContain('(+1 more)');
    expect(finding.message).not.toContain('Child 9');
  });

  it('checks animated scale channel endpoints against nested parts', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Animated Scale Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        position: [0, 0.5, 0],
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
          position: [0, 0.8, 0],
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [{
            id: 'stretch-housing',
            name: 'Stretch housing',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: {
              scale: { from: [1, 1, 1], to: [3, 1, 0.2] },
            },
          }],
        }],
      },
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      clipId: 'deploy',
      sequenceId: 'stretch-housing',
      partIds: ['housing', 'lens'],
      affectedDescendantNames: ['Lens'],
      anisotropyRatio: 15,
    });
    expect(finding.message).toContain('[3, 1, 0.2]');
    expect(finding.message).toContain('Deploy');
    expect(finding.message).toContain('stretch-housing');
  });

  it('ties the singular sequence id to the most anisotropic animated scale', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Scale Sequence Metadata Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [
            {
              id: 'mild-scale',
              name: 'Mild scale',
              partId: 'housing',
              startSeconds: 0.2,
              endSeconds: 0.4,
              channels: { scale: { from: [1, 1, 1], to: [1.5, 1, 1] } },
            },
            {
              id: 'severe-scale',
              name: 'Severe scale',
              partId: 'housing',
              startSeconds: 0.8,
              endSeconds: 1.2,
              channels: { scale: { from: [1, 1, 1], to: [3, 1, 0.2] } },
            },
          ],
        }],
      },
    });

    const finding = res.findings.find((item) => item.code === 'nonuniform-parent-scale');
    expect(finding).toMatchObject({
      sequenceId: 'severe-scale',
      sequenceIds: ['mild-scale', 'severe-scale'],
      anisotropyRatio: 15,
    });
  });

  it('does not flag a non-uniformly scaled leaf without descendants', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Scaled Leaf Spec',
      parts: [{
        id: 'plate',
        name: 'Plate',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
      }],
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
  });

  it('uses a one-percent tolerance for non-uniform scale', () => {
    const withScale = (scale) => evaluateThreejsPhysicalAudit({
      name: 'Tolerance Spec',
      parts: [{
        id: 'parent',
        name: 'Parent',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale,
        children: [{
          id: 'child',
          name: 'Child',
          geometry: { type: 'sphere', radius: 0.5 },
        }],
      }],
    });

    expect(withScale([1, 1, 1.005]).findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
    expect(withScale([1, 1, 1.02]).findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(1);
  });

  it('does not flag a uniformly animated parent scale', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Uniform Animation Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'inflate',
          name: 'Inflate',
          durationSeconds: 2,
          sequences: [{
            id: 'inflate-housing',
            name: 'Inflate housing',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: { scale: { from: [1, 1, 1], to: [2, 2, 2] } },
          }],
        }],
      },
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(0);
  });

  it('coalesces an animated duplicate when the rest pose is already more anisotropic', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Duplicate Scale Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [3, 1, 0.2],
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [{
            id: 'repeat-scale',
            name: 'Repeat scale',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: { scale: { from: [1, 1, 1], to: [3, 1, 0.2] } },
          }],
        }],
      },
    });

    expect(res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale')).toHaveLength(1);
  });

  it('keeps a stronger animated scale finding beside the rest-pose finding', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Stronger Animated Scale Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [2, 1, 1],
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [{
            id: 'stronger-scale',
            name: 'Stronger scale',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: { scale: { from: [1, 1, 1], to: [6, 1, 1] } },
          }],
        }],
      },
    });

    const findings = res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale');
    expect(findings).toHaveLength(2);
    expect(findings.find((finding) => finding.clipId)).toMatchObject({
      anisotropyRatio: 6,
      sequenceId: 'stronger-scale',
    });
  });

  it('coalesces an animated scale within the one-percent comparison band', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Scale Comparison Tolerance Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        scale: [2, 1, 1],
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          durationSeconds: 2,
          sequences: [{
            id: 'near-scale',
            name: 'Near scale',
            partId: 'housing',
            startSeconds: 0.5,
            endSeconds: 1.5,
            channels: { scale: { from: [1, 1, 1], to: [2.015, 1, 1] } },
          }],
        }],
      },
    });

    const findings = res.findings.filter((finding) => finding.code === 'nonuniform-parent-scale');
    expect(findings).toHaveLength(1);
    expect(findings[0].clipId).toBeUndefined();
  });

  it('checks scale channels in later clips after the pose budget is exhausted', () => {
    const res = evaluateThreejsPhysicalAudit({
      name: 'Later Clip Scale Spec',
      parts: [{
        id: 'housing',
        name: 'Housing',
        geometry: { type: 'box', width: 2, height: 1, depth: 1 },
        children: [{
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.4 },
        }],
      }],
      animation: {
        clips: [
          {
            id: 'pose-heavy',
            name: 'Pose heavy',
            durationSeconds: 2,
            sequences: Array.from({ length: 8 }, (_, index) => ({
              id: `pose-${index}`,
              name: `Pose ${index}`,
              partId: 'housing',
              startSeconds: (index + 1) * 0.1,
              endSeconds: (index + 1) * 0.1 + 0.05,
              channels: { position: { from: [0, 0, 0], to: [0, 0, 0] } },
            })),
          },
          {
            id: 'late-scale',
            name: 'Late scale',
            durationSeconds: 2,
            sequences: [{
              id: 'late-parent-scale',
              name: 'Late parent scale',
              partId: 'housing',
              startSeconds: 0.5,
              endSeconds: 1.5,
              channels: { scale: { from: [1, 1, 1], to: [3, 1, 1] } },
            }],
          },
        ],
      },
    });

    expect(res.findings.find((finding) => finding.code === 'nonuniform-parent-scale')).toMatchObject({
      clipId: 'late-scale',
      sequenceId: 'late-parent-scale',
    });
  });

  it('detects floating part touching nothing', () => {
    const spec = {
      name: 'Floating Spec',
      parts: [
        {
          id: 'ground_plate',
          name: 'Ground Plate',
          geometry: { type: 'box', width: 2, height: 0.2, depth: 2 },
          position: [0, 0.1, 0],
        },
        {
          id: 'floating_sphere',
          name: 'Floating Orb',
          geometry: { type: 'sphere', radius: 0.5 },
          position: [5, 5, 5],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.warningCount).toBeGreaterThanOrEqual(1);
    const finding = res.findings.find((f) => f.code === 'floating-part');
    expect(finding).toBeDefined();
    expect(finding.partIds).toContain('floating_sphere');
    expect(finding.message).toContain('Floating Orb');

    const feedback = buildThreejsPhysicalAuditFeedback(res);
    expect(feedback).toContain('Floating Orb');
    expect(feedback).not.toContain('For non-uniform parent scale findings');
  });

  it('detects buried geometry inside another part', () => {
    const spec = {
      name: 'Buried Spec',
      parts: [
        {
          id: 'container',
          name: 'Outer Container',
          geometry: { type: 'box', width: 4, height: 4, depth: 4 },
          position: [0, 2, 0],
        },
        {
          id: 'swallowed',
          name: 'Inner Gem',
          geometry: { type: 'box', width: 1, height: 1, depth: 1 },
          position: [0, 2, 0],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.errorCount).toBeGreaterThanOrEqual(1);
    const finding = res.findings.find((f) => f.code === 'buried-geometry');
    expect(finding).toBeDefined();
    expect(finding.partIds).toEqual(['swallowed', 'container']);
  });

  it('detects coplanar surfaces causing z-fighting', () => {
    const spec = {
      name: 'Coplanar Spec',
      parts: [
        {
          id: 'block1',
          name: 'Left Block',
          geometry: { type: 'box', width: 2, height: 2, depth: 2 },
          position: [-1, 1, 0],
        },
        {
          id: 'block2',
          name: 'Right Block',
          geometry: { type: 'box', width: 2, height: 2, depth: 2 },
          position: [1, 1, 0],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    const finding = res.findings.find((f) => f.code === 'coplanar-surface');
    expect(finding).toBeDefined();
    expect(finding.partIds).toContain('block1');
    expect(finding.partIds).toContain('block2');
  });

  it('exempts hidden parts (visible: false) from floating and buried checks', () => {
    const spec = {
      name: 'Hidden Parts Spec',
      parts: [
        {
          id: 'main',
          name: 'Main',
          geometry: { type: 'box', width: 2, height: 1, depth: 2 },
          position: [0, 0.5, 0],
        },
        {
          id: 'hidden_float',
          name: 'Hidden Float',
          geometry: { type: 'sphere', radius: 0.5 },
          position: [10, 10, 10],
          visible: false,
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.partIds.includes('hidden_float'))).toHaveLength(0);
  });

  it('exempts parent/child and declared attachments from false positives', () => {
    const spec = {
      name: 'Attachment Spec',
      articulation: {
        attachmentPartIds: ['strapped_pack'],
      },
      parts: [
        {
          id: 'torso',
          name: 'Torso',
          geometry: { type: 'box', width: 2, height: 3, depth: 1 },
          position: [0, 1.5, 0],
        },
        {
          id: 'strapped_pack',
          name: 'Backpack',
          geometry: { type: 'box', width: 1, height: 1, depth: 0.5 },
          position: [0, 1.5, 0.5],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.code === 'floating-part')).toHaveLength(0);
    expect(res.findings.filter((f) => f.code === 'buried-geometry')).toHaveLength(0);
  });

  it('evaluates rotated parts and transforms correctly', () => {
    const spec = {
      name: 'Rotated Spec',
      parts: [
        {
          id: 'base',
          name: 'Base',
          geometry: { type: 'box', width: 2, height: 0.2, depth: 2 },
          position: [0, 0.1, 0],
        },
        {
          id: 'tilted_arm',
          name: 'Tilted Arm',
          geometry: { type: 'box', width: 0.2, height: 2, depth: 0.2 },
          position: [0, 0.5, 0],
          rotationDegrees: [0, 0, 45],
        },
      ],
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.code === 'floating-part')).toHaveLength(0);
  });

  it('detects unprovenanced transitions in animated clip poses', () => {
    const spec = {
      name: 'Animated Spec',
      parts: [
        {
          id: 'hull',
          name: 'Hull',
          geometry: { type: 'box', width: 4, height: 1, depth: 4 },
          position: [0, 0.5, 0],
        },
        {
          id: 'pop_part',
          name: 'Popping Cannon',
          geometry: { type: 'cylinder', radiusTop: 0.2, radiusBottom: 0.2, height: 1 },
          position: [0, 5, 0],
          visible: false,
        },
      ],
      animation: {
        clips: [
          {
            id: 'deploy',
            name: 'Deploy',
            durationSeconds: 2,
            sequences: [
              {
                id: 'appear',
                name: 'Appear Sequence',
                partId: 'pop_part',
                startSeconds: 1,
                endSeconds: 2,
                channels: {
                  visible: { from: false, to: true },
                },
              },
            ],
          },
        ],
      },
    };
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.evaluatedPoseCount).toBeGreaterThan(1);
    const finding = res.findings.find((f) => f.code === 'unprovenanced-transition');
    expect(finding).toBeDefined();
    expect(finding.partIds).toContain('pop_part');
    expect(finding.clipId).toBe('deploy');
    expect(finding.sequenceId).toBe('appear');
    expect(finding.timeSeconds).toBe(1);
  });
});

// Attachment anchors. The upstream defects these mirror — a conical hat rendered
// at hip height, a charm detached from the staff it hangs off — pass every other
// check in this file: the hat touches the torso so it does not float, and nothing
// contains it so it is not buried. Only its declared anchor makes it wrong.
describe('threejsModelPhysicalAudit attachment anchors', () => {
  const box = (id, name, position, size = 0.4) => ({
    id,
    name,
    geometry: { type: 'box', width: size, height: size, depth: size },
    material: 'skin',
    position,
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    children: [],
  });

  const wornSpec = (attachments, hatPosition = [0, 1.9, 0]) => ({
    name: 'Figure',
    materials: { skin: { type: 'standard', color: '#ffffff' } },
    parts: [
      box('torso', 'Torso', [0, 1, 0], 1.2),
      box('head', 'Head', [0, 1.8, 0], 0.5),
      { ...box('hat', 'Hat', hatPosition, 0.55) },
    ],
    sockets: [{ name: 'crown', parentPartId: 'head', position: [0, 0.25, 0], rotationDegrees: [0, 0, 0] }],
    articulation: {
      joints: [
        { id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null },
        { id: 'headJoint', partId: 'head', parentJointId: 'rootJoint', pivotSocket: 'crown' },
      ],
      attachmentPartIds: [],
      attachments,
    },
  });

  const findingsOf = (spec, code) => evaluateThreejsPhysicalAudit(spec).findings.filter((f) => f.code === code);

  it('passes an attachment sitting on the part it is anchored to', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'head', anchorSocket: null, maxOffset: 0.25 }]);
    expect(findingsOf(spec, 'attachment-far-from-anchor')).toEqual([]);
    expect(findingsOf(spec, 'unanchored-attachment')).toEqual([]);
    expect(evaluateThreejsPhysicalAudit(spec).unmeasuredAttachments).toEqual([]);
  });

  it('reports an attachment measured away from its declared anchor as an error', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'head', anchorSocket: null, maxOffset: 0.25 }], [0, 0.6, 0]);
    const [finding] = findingsOf(spec, 'attachment-far-from-anchor');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('error');
    expect(finding.partIds).toEqual(['hat', 'head']);
    expect(finding.anchorPartId).toBe('head');
    expect(finding.distance).toBeGreaterThan(0.25);
    expect(finding.message).toContain('"Head"');
    // The same spec is clean for every pre-existing check: the hat touches the
    // torso, so nothing else in this gate has anything to say about it.
    expect(findingsOf(spec, 'floating-part')).toEqual([]);
    expect(findingsOf(spec, 'buried-geometry')).toEqual([]);
  });

  it('measures a socket anchor as the point it is, not as its parent part', () => {
    const anchored = [{ partId: 'hat', anchorPartId: null, anchorSocket: 'crown', maxOffset: 0.05 }];
    expect(findingsOf(wornSpec(anchored), 'attachment-far-from-anchor')).toEqual([]);
    const [finding] = findingsOf(wornSpec(anchored, [0, 0.6, 0]), 'attachment-far-from-anchor');
    expect(finding).toBeDefined();
    expect(finding.anchorSocket).toBe('crown');
    expect(finding.partIds).toEqual(['hat']);
    expect(finding.message).toContain('socket "crown"');
  });

  it('warns on a legacy attachment that names nothing to hang from', () => {
    const spec = wornSpec([]);
    spec.articulation.attachmentPartIds = ['hat'];
    const [finding] = findingsOf(spec, 'unanchored-attachment');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('warning');
    expect(finding.partIds).toEqual(['hat']);
    expect(finding.message).toContain('"Hat"');
  });

  // An anchor whose surface cannot be measured was not checked, and a gate that
  // reports "not checked" as "clean" is the failure mode this list prevents.
  it('reports an attachment whose anchor has no measurable geometry as unmeasured, never as passing', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'group', anchorSocket: null, maxOffset: 0.25 }]);
    spec.parts.push({
      id: 'group',
      name: 'Group',
      position: [0, 0, 0],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [],
    });
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.findings.filter((f) => f.code === 'attachment-far-from-anchor')).toEqual([]);
    expect(res.unmeasuredAttachments).toEqual([
      { partId: 'hat', anchorPartId: 'group', anchorSocket: null, reason: 'the anchor part has no visible geometry to measure' },
    ]);
  });

  // An anchor that is a bare group is still measurable through its children —
  // "head" holding a skull and a jaw is the normal way to author one.
  it('measures an anchor group through the geometry of its descendants', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'headGroup', anchorSocket: null, maxOffset: 0.25 }]);
    spec.parts[1] = {
      id: 'headGroup',
      name: 'Head group',
      position: [0, 1.8, 0],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [box('skull', 'Skull', [0, 0, 0], 0.5)],
    };
    spec.sockets = [];
    spec.articulation.joints = [{ id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null }];
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.unmeasuredAttachments).toEqual([]);
    expect(res.findings.filter((f) => f.code === 'attachment-far-from-anchor')).toEqual([]);
  });

  // The natural authoring shape, and the one that defeats a naive subtree
  // measurement: the hat is a CHILD of the head, so folding its own geometry into
  // the head's bounds would measure it zero units from itself no matter where it
  // sits. The anchor's bounds exclude the attachment's own subtree.
  it('measures a nested attachment against its anchor rather than against itself', () => {
    const nested = {
      name: 'Figure',
      materials: { skin: { type: 'standard', color: '#ffffff' } },
      parts: [{
        ...box('torso', 'Torso', [0, 1, 0], 1.2),
        children: [{
          ...box('head', 'Head', [0, 0.9, 0], 0.5),
          // Authored on the head but positioned at hip height — the upstream defect.
          children: [box('hat', 'Hat', [0, -1.5, 0], 0.55)],
        }],
      }],
      sockets: [],
      articulation: {
        joints: [{ id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null }],
        attachmentPartIds: [],
        attachments: [{ partId: 'hat', anchorPartId: 'head', anchorSocket: null, maxOffset: 0.25 }],
      },
    };
    const [finding] = evaluateThreejsPhysicalAudit(nested).findings.filter((f) => f.code === 'attachment-far-from-anchor');
    expect(finding).toBeDefined();
    expect(finding.distance).toBeGreaterThan(0.25);

    // …and the same hierarchy with the hat actually on the head stays clean.
    nested.parts[0].children[0].children = [box('hat', 'Hat', [0, 0.4, 0], 0.55)];
    expect(evaluateThreejsPhysicalAudit(nested).findings.filter((f) => f.code === 'attachment-far-from-anchor')).toEqual([]);
  });

  // A clip pose that hides the anchor did not disprove the resting-pose
  // measurement, so it must not turn a checked attachment into an unchecked one.
  it('keeps an attachment measured in the resting pose out of the unmeasured list', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'head', anchorSocket: null, maxOffset: 0.25 }]);
    spec.animation = {
      clips: [{
        id: 'vanish',
        name: 'Vanish',
        durationSeconds: 1,
        sequences: [{
          id: 'hideHead',
          name: 'Hide head',
          partId: 'head',
          startSeconds: 0,
          endSeconds: 1,
          channels: { visible: { from: true, to: false } },
        }],
      }],
    };
    expect(evaluateThreejsPhysicalAudit(spec).unmeasuredAttachments).toEqual([]);
  });

  it('catches a clip that carries an attachment away from its anchor mid-clip', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'head', anchorSocket: null, maxOffset: 0.25 }]);
    spec.animation = {
      clips: [{
        id: 'toss',
        name: 'Toss',
        durationSeconds: 2,
        sequences: [{
          id: 'lift',
          name: 'Lift',
          partId: 'hat',
          startSeconds: 0,
          endSeconds: 2,
          channels: { position: { from: [0, 1.9, 0], to: [0, 5, 0] } },
        }],
      }],
    };
    const [finding] = findingsOf(spec, 'attachment-far-from-anchor');
    expect(finding).toBeDefined();
    expect(finding.clipId).toBe('toss');
    expect(finding.timeSeconds).toBe(2);
    expect(finding.message).toContain('In clip "Toss"');
  });

  it('names the anchor in the refinement feedback, so the next pass has somewhere to move the part', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'head', anchorSocket: null, maxOffset: 0.25 }], [0, 0.6, 0]);
    const feedback = buildThreejsPhysicalAuditFeedback(evaluateThreejsPhysicalAudit(spec));
    expect(feedback).toContain('"head"');
    expect(feedback).toContain('Anchoring to the model root is not acceptable');
  });

  // Unmeasured is actionable on its own: nothing else in the report would tell
  // the next pass that the relationship was never verified.
  it('feeds an unmeasured attachment back even when no finding fired', () => {
    const spec = wornSpec([{ partId: 'hat', anchorPartId: 'group', anchorSocket: null, maxOffset: 0.25 }]);
    spec.parts.push({
      id: 'group', name: 'Group', position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1], children: [],
    });
    const res = evaluateThreejsPhysicalAudit(spec);
    expect(res.errorCount).toBe(0);
    expect(res.warningCount).toBe(0);
    const feedback = buildThreejsPhysicalAuditFeedback(res);
    expect(feedback).toContain('could not be checked against "group"');
  });

  // Bilateral chirality is invisible to every bounds check above: a hand spun
  // 180° about the vertical axis fills exactly the same box as a reflected one,
  // so these cases pin the transform relationship rather than the geometry.
  describe('bilateral chirality', () => {
    // A swept profile, not a box: a box maps onto itself under a 180° yaw, so
    // nothing distinguishes a reflected one from a turned-around one.
    const hand = { type: 'tube', path: [[0, 0, -0.25], [0, 0, 0.25]], radius: 0.15 };
    const bilateralSpec = (left, right) => ({
      name: 'Bilateral Figure',
      parts: [
        {
          id: 'torso',
          name: 'Torso',
          geometry: { type: 'box', width: 1, height: 2, depth: 0.6 },
          position: [0, 1, 0],
          children: [
            { id: 'hand-l', name: 'Hand Left', geometry: hand, position: [0.6, 0, 0.2], ...left },
            { id: 'hand-r', name: 'Hand Right', geometry: hand, position: [-0.6, 0, 0.2], ...right },
          ],
        },
      ],
    });
    const codes = (spec) => evaluateThreejsPhysicalAudit(spec).findings
      .filter((finding) => finding.code.startsWith('bilateral-'))
      .map((finding) => finding.code);

    it('accepts a pair reflected across the lateral plane', () => {
      const spec = bilateralSpec(
        { rotationDegrees: [10, 20, 30] },
        { rotationDegrees: [10, -20, -30] },
      );
      expect(codes(spec)).toEqual([]);
      expect(buildThreejsPhysicalAuditFeedback(evaluateThreejsPhysicalAudit(spec))).toBe('');
    });

    it('flags a pair mirrored by a 180 degree yaw instead of a reflection', () => {
      const res = evaluateThreejsPhysicalAudit(bilateralSpec({}, { rotationDegrees: [0, 180, 0] }));
      const finding = res.findings.find((f) => f.code === 'bilateral-chirality');
      expect(finding.severity).toBe('warning');
      expect(finding.partIds).toEqual(['hand-l', 'hand-r']);
      expect(finding.message).toContain('carries the orientation of "Hand Left" turned around');
      expect(finding.message).toContain('[rx, -ry, -rz]');
    });

    // A figure mid-stride has one hand forward and one back. Depth alone is a
    // pose, and reporting it would ask the next pass to flatten every pose.
    it('ignores a staggered pose that only differs in depth', () => {
      expect(codes(bilateralSpec({}, { position: [-0.6, 0, -0.2] }))).toEqual([]);
    });

    // Depth is reported once the orientation already says the limb is turned
    // around, because it says where the reflected limb should have gone.
    it('names the reflected placement alongside a yawed orientation', () => {
      const res = evaluateThreejsPhysicalAudit(bilateralSpec(
        {},
        { position: [-0.6, 0, -0.2], rotationDegrees: [0, 180, 0] },
      ));
      const finding = res.findings.find((finding) => finding.code === 'bilateral-chirality');
      expect(finding.message).toContain('where a reflection would place it at [-0.6, 0, 0.2]');
    });

    it('flags a pair mirrored by negating a scale component', () => {
      const res = evaluateThreejsPhysicalAudit(bilateralSpec({}, { scale: [-1, 1, 1] }));
      const finding = res.findings.find((f) => f.code === 'bilateral-mirror-scale');
      expect(finding.message).toContain('negating a scale component on "Hand Right"');
      // The negated half is the one named, not whichever side happens to be first.
      expect(finding.message).toContain('relative to "Hand Left"');
    });

    it('flags a pair that never crosses the lateral plane', () => {
      const res = evaluateThreejsPhysicalAudit(bilateralSpec({}, { position: [0.6, 0, -1.2] }));
      const finding = res.findings.find((f) => f.code === 'bilateral-pair-same-side');
      expect(finding.message).toContain('sits entirely on one side of the lateral plane');
    });

    // A merely asymmetric pose is legitimate — only a positively identified yaw
    // is a defect, or the gate would report every raised arm.
    it('ignores a pair posed differently without a chirality flip', () => {
      expect(codes(bilateralSpec({}, { rotationDegrees: [25, -20, -30] }))).toEqual([]);
    });

    it('pairs across naming conventions and camelCase', () => {
      const spec = bilateralSpec({}, { rotationDegrees: [0, 180, 0] });
      spec.parts[0].children[0].name = 'leftFoot';
      spec.parts[0].children[1].name = 'foot_R';
      expect(codes(spec)).toEqual(['bilateral-chirality']);
    });

    // Which counterpart a third same-side part is meant to mirror is unknowable,
    // and guessing would report chirality against the wrong limb.
    it('skips a group that cannot be paired one to one', () => {
      const spec = bilateralSpec({}, { rotationDegrees: [0, 180, 0] });
      spec.parts[0].children.push({
        id: 'hand-l-spare', name: 'Hand Left', geometry: hand, position: [0.6, 0.8, 0.2],
      });
      expect(codes(spec)).toEqual([]);
    });

    // A box reads the same either way round, so the yaw is not a defect and
    // reporting it would bury the real findings under every blocky limb.
    it('ignores a yaw on a lone geometry that maps onto itself', () => {
      const spec = bilateralSpec({}, { rotationDegrees: [0, 180, 0] });
      spec.parts[0].children[0].geometry = { type: 'box', width: 0.3, height: 0.3, depth: 0.5 };
      spec.parts[0].children[1].geometry = { type: 'box', width: 0.3, height: 0.3, depth: 0.5 };
      expect(codes(spec)).toEqual([]);
    });

    it('ignores a name whose only token is a side word', () => {
      const spec = bilateralSpec({}, { rotationDegrees: [0, 180, 0] });
      spec.parts[0].children[0].name = 'Left';
      spec.parts[0].children[0].id = 'left';
      spec.parts[0].children[1].name = 'Right';
      spec.parts[0].children[1].id = 'right';
      expect(codes(spec)).toEqual([]);
    });

    // The lateral plane a pair mirrors across is the one their shared parent
    // defines, never world x = 0 — a subject modelled off the origin or facing
    // anywhere but down +Z is symmetric about its own axis and no world plane.
    it('measures a pair against its parent rather than world x = 0', () => {
      const spec = bilateralSpec({}, {});
      spec.parts[0].position = [3, 1, 0];
      expect(codes(spec)).toEqual([]);
    });

    it('measures a pair inside a yawed parent in the parent frame', () => {
      const spec = bilateralSpec(
        { rotationDegrees: [0, 90, 0] },
        { rotationDegrees: [0, -90, 0] },
      );
      spec.parts[0].rotationDegrees = [0, 35, 0];
      expect(codes(spec)).toEqual([]);
    });

    // Both id and name, or the pair resolves through the id fallback and never
    // exercises the upper-upper-lower camel split this case exists for.
    it('pairs a single-letter side prefix run onto the name', () => {
      const spec = bilateralSpec({}, { rotationDegrees: [0, 180, 0] });
      spec.parts[0].children[0].id = 'LHand';
      spec.parts[0].children[0].name = 'LHand';
      spec.parts[0].children[1].id = 'RHand';
      spec.parts[0].children[1].name = 'RHand';
      expect(codes(spec)).toEqual(['bilateral-chirality']);
    });

    it('feeds bilateral findings back with the reflection recipe', () => {
      const feedback = buildThreejsPhysicalAuditFeedback(
        evaluateThreejsPhysicalAudit(bilateralSpec({}, { rotationDegrees: [0, 180, 0] })),
      );
      expect(feedback).toContain('For bilateral pair findings');
      expect(feedback).toContain('position [-x, y, z] and rotation [rx, -ry, -rz]');
    });
  });
});

// A straight horn is invisible to every check above — its bounding box is a
// perfectly reasonable box, it penetrates nothing, and it touches its parent.
// Only what the spec CALLS the part makes the straight sweep a defect.
describe('swept-path curvature', () => {
  const arcPath = (spanDegrees, count = 8) => Array.from({ length: count }, (_, index) => {
    const angle = (index / (count - 1)) * spanDegrees * (Math.PI / 180);
    return [Math.cos(angle) - 1, Math.sin(angle), 0];
  });
  const hornSpec = (horn, detailInventory) => ({
    name: 'Horned Figure',
    parts: [
      {
        id: 'skull',
        name: 'Skull',
        geometry: { type: 'box', width: 1, height: 1, depth: 1 },
        position: [0, 0.5, 0],
        children: [{ id: 'horn', name: 'Horn', position: [0, 0.5, 0], ...horn }],
      },
    ],
    ...(detailInventory ? { detailInventory } : {}),
  });
  const sweptFindings = (spec) => evaluateThreejsPhysicalAudit(spec).findings
    .filter((finding) => finding.code === 'straight-swept-path');

  it('flags a horn swept along collinear control points', () => {
    const findings = sweptFindings(hornSpec({
      geometry: { type: 'tube', path: [[0, 0, 0], [0, 0.5, 0], [0, 1, 0]], radius: 0.1 },
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].partIds).toEqual(['horn']);
    expect(findings[0].message).toContain('collinear control points');
  });

  it('reports the measured span for a horn that bends too little', () => {
    const findings = sweptFindings(hornSpec({
      geometry: { type: 'tube', path: arcPath(12), radius: 0.1 },
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('only turns through 12°');
  });

  it('accepts a horn that actually curves', () => {
    expect(sweptFindings(hornSpec({
      geometry: { type: 'tube', path: arcPath(80), radius: 0.1 },
    }))).toEqual([]);
  });

  // `tube` is the right answer for plenty of straight parts, so a straight
  // sweep is evidence of nothing until the spec says the part was meant to bend.
  it('leaves an undeclared straight tube alone', () => {
    const spec = hornSpec({
      geometry: { type: 'tube', path: [[0, 0, 0], [0, 0.5, 0], [0, 1, 0]], radius: 0.1 },
    });
    spec.parts[0].children[0].name = 'Antenna Mast';
    expect(sweptFindings(spec)).toEqual([]);
  });

  it('names the detail feature when the part name does not declare the curve', () => {
    const spec = hornSpec(
      { geometry: { type: 'tube', path: [[0, 0, 0], [0, 0.5, 0], [0, 1, 0]], radius: 0.1 } },
      [{ feature: 'coiled brass conduit', evidence: 'reference photo', implementationPartIds: ['horn'], priority: 'identity' }],
    );
    spec.parts[0].children[0].name = 'Conduit';
    const findings = sweptFindings(spec);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('declared by the feature "coiled brass conduit"');
  });

  // An extrude sweeps along a straight axis, so its outline is the only place
  // a curve can live — and a convex outline has no curve in it at all.
  it('flags a curved feature built from a convex extrude outline', () => {
    const findings = sweptFindings(hornSpec({
      geometry: {
        type: 'extrude',
        outline: [[0, 0], [0.2, 0], [0.1, 1]],
        depth: 0.2,
        bevelEnabled: true,
        bevelThickness: 0.05,
      },
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('0° of sustained concave turning');
  });

  it('accepts a crescent extrude outline', () => {
    const outer = Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 11) * Math.PI * 0.8;
      return [Math.cos(angle), Math.sin(angle)];
    });
    const inner = Array.from({ length: 12 }, (_, index) => {
      const angle = (Math.PI * 0.8) - ((index / 11) * Math.PI * 0.8);
      return [0.75 * Math.cos(angle), 0.75 * Math.sin(angle)];
    });
    expect(sweptFindings(hornSpec({
      geometry: { type: 'extrude', outline: [...outer, ...inner], depth: 0.2 },
    }))).toEqual([]);
  });

  it('feeds the finding back with the recipe for putting the curve in the geometry', () => {
    const feedback = buildThreejsPhysicalAuditFeedback(evaluateThreejsPhysicalAudit(hornSpec({
      geometry: { type: 'tube', path: [[0, 0, 0], [0, 0.5, 0], [0, 1, 0]], radius: 0.1 },
    })));
    expect(feedback).toContain('For straight swept-path findings');
    expect(feedback).toContain('outline itself has a concave side');
  });
});

