import { describe, it, expect } from 'vitest';
import { greyboxSceneSchema, resolveGreybox } from './greyboxScene.js';
import editingParts from './fixtures/greyboxEditing.json' with { type: 'json' };

const rink = () => ({
  parts: [
    { id: 'floor', type: 'extrude', outline: [[-15, -7], [15, -7], [15, 7], [-15, 7]], height: 0.1, zone: 'skate' },
    { id: 'booth', type: 'box', size: [3, 2.5, 2], position: [0, 1.25, -8] },
  ],
  zones: [{ id: 'skate', label: 'Skate floor', color: '#8899aa' }],
  anchors: [{ id: 'lead', label: 'Lead skater', kind: 'figure', position: [2, 0, 1] }],
  shots: [{ id: 'wide', label: 'Wide', position: [0, 4, 14], target: [0, 1, 0], figures: [{ anchorId: 'lead', pose: 'mid-spin' }] }],
});

describe('greyboxSceneSchema', () => {
  it.each(Object.entries(editingParts))('accepts the client editor’s %s wire fixture and rejects an invalid extent', (_type, part) => {
    expect(greyboxSceneSchema.safeParse({ parts: [part] }).success).toBe(true);
    const invalid = structuredClone(part);
    if (invalid.size) invalid.size[0] = 0;
    else invalid.height = 0;
    expect(greyboxSceneSchema.safeParse({ parts: [invalid] }).success).toBe(false);
  });

  it('accepts a minimal rink and applies defaults', () => {
    const scene = greyboxSceneSchema.parse(rink());
    expect(scene.source).toBe('spec');
    expect(scene.anchors[0].heightMeters).toBe(1.7);
    expect(scene.shots[0].focalLengthMm).toBe(35);
  });

  it('rejects dangling references, duplicate ids and a degenerate camera', () => {
    const bad = rink();
    bad.parts[0].zone = 'nope';
    bad.parts.push({ ...bad.parts[1] });
    bad.shots[0].figures[0].anchorId = 'ghost';
    bad.shots.push({ id: 'flat', label: 'Flat', position: [1, 1, 1], target: [1, 1, 1] });
    const messages = greyboxSceneSchema.safeParse(bad).error.issues.map((i) => i.message).join('|');
    expect(messages).toMatch(/unknown zone "nope"/);
    expect(messages).toMatch(/duplicate parts id "booth"/);
    expect(messages).toMatch(/unknown anchor "ghost"/);
    expect(messages).toMatch(/sits on its target/);
  });

  it('keeps a shot id short enough for its capture role', () => {
    const ok = rink();
    ok.shots[0].id = `s${'a'.repeat(50)}`;
    expect(greyboxSceneSchema.safeParse(ok).success).toBe(true);
    const tooLong = rink();
    tooLong.shots[0].id = `s${'a'.repeat(51)}`;
    expect(greyboxSceneSchema.safeParse(tooLong).success).toBe(false);
  });

  it('requires parts for a spec source but not for a glb source', () => {
    expect(greyboxSceneSchema.safeParse({ source: 'spec' }).success).toBe(false);
    expect(greyboxSceneSchema.safeParse({ source: 'glb', shots: [] }).success).toBe(true);
  });
});

describe('resolveGreybox', () => {
  it('reads an absent or invalid blob as no greybox', () => {
    expect(resolveGreybox({})).toBeNull();
    expect(resolveGreybox({ greybox: { parts: 'x' } })).toBeNull();
    expect(resolveGreybox({ greybox: rink() })?.parts).toHaveLength(2);
  });
});
