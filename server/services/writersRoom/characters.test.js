import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const local = await import('./local.js');
const characters = await import('./characters.js');
const { createWork } = local;
const {
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
  mergeExtractedCharacters,
} = characters;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-chars-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function newWork() {
  const w = await createWork({ title: 'Test Work', kind: 'short-story' });
  return w.id;
}

describe('writers room — characters CRUD', () => {
  it('starts with an empty bible', async () => {
    const id = await newWork();
    expect(await listCharacters(id)).toEqual([]);
  });

  it('rejects path-traversal-shaped work ids on every read/write helper', async () => {
    // Every public helper interpolates workId into an on-disk path; a
    // crafted id like '../../etc' must be refused with a 400 before any
    // filesystem access. This protects callers that bypass the route layer.
    await expect(listCharacters('../../etc')).rejects.toThrow(/work id/i);
    await expect(createCharacter('../../etc', { name: 'X' })).rejects.toThrow(/work id/i);
    await expect(mergeExtractedCharacters('../../etc', [{ name: 'X' }])).rejects.toThrow(/work id/i);
  });

  it('rejects creating without a name', async () => {
    const id = await newWork();
    await expect(createCharacter(id, { name: '   ' })).rejects.toThrow(/name required/i);
  });

  it('rejects duplicate names (case-insensitive)', async () => {
    const id = await newWork();
    await createCharacter(id, { name: 'Aria', physicalDescription: 'short' });
    await expect(createCharacter(id, { name: 'aria' })).rejects.toThrow(/already exists/i);
  });

  it('creates and updates a profile', async () => {
    const id = await newWork();
    const c = await createCharacter(id, { name: 'Mila', physicalDescription: 'tall' });
    expect(c.name).toBe('Mila');
    expect(c.physicalDescription).toBe('tall');
    expect(c.id).toMatch(/^wr-char-/);

    const updated = await updateCharacter(id, c.id, { physicalDescription: 'tall, copper hair' });
    expect(updated.physicalDescription).toBe('tall, copper hair');
    expect(updated.source).toBe('user');
  });

  it('persists portable character production metadata accepted by the route schema', async () => {
    const id = await newWork();
    const c = await createCharacter(id, {
      name: 'Mila',
      voiceCanon: { version: 1, description: 'warm alto', approved: true },
      identityPack: { avoid: ['different eye color'] },
    });
    expect(c.voiceCanon).toMatchObject({ version: 1, description: 'warm alto', approved: true });
    expect(c.identityPack).toEqual({ assets: [], avoid: ['different eye color'] });

    const updated = await updateCharacter(id, c.id, {
      voiceCanon: { version: 2, description: 'urgent alto', approved: false },
    });
    expect(updated.voiceCanon).toMatchObject({ version: 2, description: 'urgent alto', approved: false });
    expect(updated.identityPack).toEqual(c.identityPack);
  });

  it('deletes a profile', async () => {
    const id = await newWork();
    const c = await createCharacter(id, { name: 'Vox' });
    await deleteCharacter(id, c.id);
    expect(await listCharacters(id)).toHaveLength(0);
  });
});

describe('writers room — characters merge', () => {
  it('adds new characters from extraction', async () => {
    const id = await newWork();
    const merged = await mergeExtractedCharacters(id, [
      { name: 'Aria', physicalDescription: 'thirties, athletic, auburn hair', role: 'protagonist' },
      { name: 'Mr. Voss', role: 'antagonist' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.name === 'Aria')?.physicalDescription).toBe('thirties, athletic, auburn hair');
    expect(merged.every((c) => c.source === 'ai')).toBe(true);
  });

  it('preserves user edits when re-merging', async () => {
    const id = await newWork();
    const c = await createCharacter(id, {
      name: 'Aria',
      physicalDescription: 'USER VERSION — short, dark hair, scar on cheek',
    });
    expect(c.source).toBe('user');

    const merged = await mergeExtractedCharacters(id, [{
      name: 'aria',
      physicalDescription: 'AI VERSION — tall, blonde',
      personality: 'quiet, observant',
      role: 'protagonist',
    }]);
    const refreshed = merged.find((x) => x.id === c.id);
    expect(refreshed.physicalDescription).toBe('USER VERSION — short, dark hair, scar on cheek');
    expect(refreshed.personality).toBe('quiet, observant');
    expect(refreshed.role).toBe('protagonist');
  });

  it('matches existing character by alias when merging', async () => {
    const id = await newWork();
    await createCharacter(id, { name: 'Mr. Voss', aliases: ['Voss', 'The Director'], role: 'antagonist' });
    const merged = await mergeExtractedCharacters(id, [{
      name: 'The Director',
      physicalDescription: 'late fifties, gray suit, bald, sharp jaw',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Mr. Voss');
    expect(merged[0].physicalDescription).toBe('late fifties, gray suit, bald, sharp jaw');
  });

  it('does not duplicate when later batch entries use a new character\'s alias as their name', async () => {
    // Simulates an extraction batch where the model first introduces a
    // character with aliases, then references the same character by an
    // alias as the `name` of a later entry. Both must resolve to one
    // canonical profile — no duplicate.
    const id = await newWork();
    const merged = await mergeExtractedCharacters(id, [
      { name: 'Mr. Voss', aliases: ['Voss', 'The Director'], role: 'antagonist' },
      { name: 'The Director', physicalDescription: 'late fifties, gray suit' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Mr. Voss');
    expect(merged[0].physicalDescription).toBe('late fifties, gray suit');
  });

  it('does not duplicate when an existing character has aliases filled in mid-batch', async () => {
    // An existing character with no aliases gets aliases filled by the
    // first incoming entry; a later entry in the same batch references the
    // character via one of those aliases. Must resolve to the same record.
    const id = await newWork();
    await createCharacter(id, { name: 'Aria' });
    const merged = await mergeExtractedCharacters(id, [
      { name: 'aria', aliases: ['Ari', 'A.'] },
      { name: 'Ari', physicalDescription: 'thirties, athletic' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].physicalDescription).toBe('thirties, athletic');
  });

  it('refreshes prose-derived metadata even when text fields are preserved', async () => {
    const id = await newWork();
    const c = await createCharacter(id, { name: 'Aria', physicalDescription: 'kept' });
    const merged = await mergeExtractedCharacters(id, [{
      name: 'Aria',
      physicalDescription: 'ignored',
      missingFromProse: ['hair color', 'eye color'],
      evidence: ['"She walked in,"'],
      firstAppearance: 'Chapter 1',
    }]);
    const updated = merged.find((x) => x.id === c.id);
    expect(updated.physicalDescription).toBe('kept');
    expect(updated.missingFromProse).toEqual(['hair color', 'eye color']);
    expect(updated.firstAppearance).toBe('Chapter 1');
  });
});

describe('writers room — character narrative framework (#6417)', () => {
  it('creates, patches and clears the framework the Universe bible already stores', async () => {
    const id = await newWork();
    const created = await createCharacter(id, {
      name: 'Wren Calloway',
      motivations: 'Keep the crew fed; never be the one who leaves.',
      ghost: 'Left behind at the relay station at nine.',
      wound: 'Reads every silence as abandonment.',
      lie: 'I only matter while I am useful.',
      need: 'Being wanted is not the same as being needed.',
      want: 'Buy back the family salvage license.',
      arcType: 'positive',
      secrets: ['Sold the license years ago', 'Cannot read the old charts'],
    });
    expect(created.id).toMatch(/^wr-char-/);
    expect(created.lie).toBe('I only matter while I am useful.');
    expect(created.arcType).toBe('positive');
    expect(created.secrets).toEqual(['Sold the license years ago', 'Cannot read the old charts']);

    // Patch one belief field; every other framework value is untouched.
    const patched = await updateCharacter(id, created.id, {
      need: 'Being wanted is enough.',
    });
    expect(patched.need).toBe('Being wanted is enough.');
    expect(patched.ghost).toBe('Left behind at the relay station at nine.');
    expect(patched.secrets).toHaveLength(2);

    // Present-but-empty is a real clear, not an absent key.
    const cleared = await updateCharacter(id, created.id, {
      lie: '', arcType: null, secrets: [],
    });
    expect(cleared.lie).toBe('');
    expect(cleared.arcType).toBeNull();
    expect(cleared.secrets).toEqual([]);
    expect(cleared.need).toBe('Being wanted is enough.');

    const [reloaded] = await listCharacters(id);
    expect(reloaded.want).toBe('Buy back the family salvage license.');
    expect(reloaded.lie).toBe('');
    expect(reloaded.arcType).toBeNull();
  });

  it('persists the links, wardrobes and voice id the route schema already accepted', async () => {
    // All three were validated by writersRoomCharacter*Schema but missing from
    // the store's editableFields, so the write was accepted and silently
    // dropped — the same class of bug as the framework itself.
    const id = await newWork();
    const other = await createCharacter(id, { name: 'Ines Mbeki' });
    const c = await createCharacter(id, {
      name: 'Wren Calloway',
      relationshipLinks: [{ targetCharacterId: other.id, type: 'rival', description: 'Same salvage claim.' }],
      wardrobes: [{ name: 'Dock coat', description: 'Oil-stained canvas.' }],
      voiceId: 'kokoro:af_heart',
    });
    expect(c.relationshipLinks).toHaveLength(1);
    expect(c.relationshipLinks[0].targetCharacterId).toBe(other.id);
    expect(c.wardrobes[0].name).toBe('Dock coat');
    expect(c.voiceId).toBe('kokoro:af_heart');
  });

  it('extraction never clobbers an authored framework field', async () => {
    const id = await newWork();
    const authored = await createCharacter(id, {
      name: 'Wren Calloway',
      lie: 'AUTHORED — I only matter while I am useful.',
      arcType: 'positive',
    });
    const merged = await mergeExtractedCharacters(id, [{
      name: 'wren calloway',
      lie: 'EXTRACTED — she fears the dark.',
      arcType: 'negative',
      ghost: 'EXTRACTED — left behind at the relay station.',
      secrets: ['Sold the license'],
    }]);
    const refreshed = merged.find((x) => x.id === authored.id);
    expect(refreshed.lie).toBe('AUTHORED — I only matter while I am useful.');
    expect(refreshed.arcType).toBe('positive');
    // Blank fields are still filled from prose — no-clobber, not no-write.
    expect(refreshed.ghost).toBe('EXTRACTED — left behind at the relay station.');
    expect(refreshed.secrets).toEqual(['Sold the license']);
  });
});

describe('writers room — psychology, sliders and links (#6417)', () => {
  it('creates, patches and clears the psychology profile and the Three Sliders', async () => {
    const id = await newWork();
    const created = await createCharacter(id, {
      name: 'Wren Calloway',
      psychology: {
        theoryOfControl: 'If I stay useful, nobody leaves.',
        strategy: 'Takes on everyone else’s work and never asks for anything.',
        drives: { connection: { desire: 'To be kept', fear: 'To be set down' } },
      },
      sliders: { proactivity: 8, competence: 6 },
    });
    expect(created.psychology.theoryOfControl).toBe('If I stay useful, nobody leaves.');
    expect(created.psychology.drives.connection.fear).toBe('To be set down');
    // Unfilled axes materialize as blank leaves, never as an absent slot.
    expect(created.psychology.drives.survival).toEqual({ desire: '', fear: '' });
    expect(created.sliders).toEqual({ proactivity: 8, likability: null, competence: 6 });

    // Patch one leaf; the rest of the profile and the sliders are untouched.
    const patched = await updateCharacter(id, created.id, {
      psychology: { ...created.psychology, presentCost: 'Never says what she wants.' },
    });
    expect(patched.psychology.presentCost).toBe('Never says what she wants.');
    expect(patched.psychology.theoryOfControl).toBe('If I stay useful, nobody leaves.');
    expect(patched.sliders.proactivity).toBe(8);

    // An assessment alone keeps the profile: the author ruled the interior out
    // rather than leaving it unfilled, and that is a real answer.
    const ruledOut = await updateCharacter(id, created.id, {
      psychology: { assessment: 'not-applicable', assessmentNote: 'A weather front, not a person.' },
    });
    expect(ruledOut.psychology.assessment).toBe('not-applicable');
    expect(ruledOut.psychology.theoryOfControl).toBe('');

    // Present-but-empty is a real clear; an absent key would have preserved it.
    const cleared = await updateCharacter(id, created.id, {
      psychology: null,
      sliders: { proactivity: null, likability: null, competence: null },
    });
    expect(cleared.psychology).toBeUndefined();
    expect(cleared.sliders).toEqual({ proactivity: null, likability: null, competence: null });

    const [reloaded] = await listCharacters(id);
    expect(reloaded.psychology).toBeUndefined();
    expect(reloaded.sliders.proactivity).toBeNull();
  });

  it('keeps an authored psychology profile when extraction proposes another', async () => {
    const id = await newWork();
    const authored = await createCharacter(id, {
      name: 'Wren Calloway',
      psychology: { theoryOfControl: 'AUTHORED — if I stay useful, nobody leaves.' },
    });
    const merged = await mergeExtractedCharacters(id, [{
      name: 'wren calloway',
      psychology: { theoryOfControl: 'EXTRACTED — she fears the dark.' },
    }]);
    const refreshed = merged.find((x) => x.id === authored.id);
    expect(refreshed.psychology.theoryOfControl).toBe('AUTHORED — if I stay useful, nobody leaves.');
  });

  it('patches a relationship link without dropping its opposing-force tag', async () => {
    // The Writers Room row editor authors target/type/description only; an
    // `opposition` block tagged in the Universe cast editor rides through.
    const id = await newWork();
    const other = await createCharacter(id, { name: 'Ines Mbeki' });
    const c = await createCharacter(id, {
      name: 'Wren Calloway',
      relationshipLinks: [{
        targetCharacterId: other.id,
        type: 'rival',
        description: 'Same salvage claim.',
        opposition: { axis: 'winner/loser', thisRole: 'challenger', targetRole: 'holder' },
      }],
    });
    const link = c.relationshipLinks[0];
    const patched = await updateCharacter(id, c.id, {
      relationshipLinks: [{ ...link, type: 'antagonist', description: 'Same claim, now in court.' }],
    });
    expect(patched.relationshipLinks[0].type).toBe('antagonist');
    expect(patched.relationshipLinks[0].opposition.axis).toBe('winner/loser');

    const emptied = await updateCharacter(id, c.id, { relationshipLinks: [] });
    expect(emptied.relationshipLinks).toEqual([]);
  });
});

describe('writers room — story-scoped evolution lens (#6445)', () => {
  const LENS = {
    outcome: 'full-change',
    outcomeNote: 'She stops keeping score.',
    stages: [
      {
        stageId: 'control-strategy-failing',
        testedBelief: 'If the ledger balances, nobody leaves.',
        externalPressure: 'The harbor master calls in the note.',
        evidence: { segmentId: 'seg-001', anchorQuote: 'balanced the books' },
      },
      {
        stageId: 'final-proof',
        characterChoice: 'She lets the boat go without counting.',
        causalConsequence: 'The debt stays, and so does she.',
        evidence: { segmentId: 'seg-002' },
      },
    ],
  };

  it('round-trips an authored lens through create, list and update', async () => {
    const id = await newWork();
    // The write has to survive BOTH gates: the route schema (pipelineValidation)
    // and the store's `editableFields` allowlist. A field the schema accepts and
    // the allowlist omits is validated and then silently dropped.
    const created = await createCharacter(id, { name: 'Wren Calloway', evolution: LENS });
    expect(created.evolution.outcome).toBe('full-change');
    expect(created.evolution.stages).toHaveLength(2);

    const [reloaded] = await listCharacters(id);
    expect(reloaded.evolution).toEqual(created.evolution);
    // Stages persist in canonical sequence order regardless of authoring order.
    expect(reloaded.evolution.stages.map((s) => s.stageId))
      .toEqual(['control-strategy-failing', 'final-proof']);
    expect(reloaded.evolution.stages[0].evidence).toMatchObject({
      segmentId: 'seg-001', anchorQuote: 'balanced the books',
    });

    const updated = await updateCharacter(id, created.id, {
      evolution: { ...LENS, outcome: 'partial-open' },
    });
    expect(updated.evolution.outcome).toBe('partial-open');
  });

  it('treats an omitted key as "leave it alone" and an explicit null as a clear', async () => {
    const id = await newWork();
    const created = await createCharacter(id, { name: 'Wren Calloway', evolution: LENS });

    // Absent → preserved (an unrelated edit must not delete authored planning).
    const renamed = await updateCharacter(id, created.id, { role: 'protagonist' });
    expect(renamed.evolution).toEqual(created.evolution);

    // Present-but-empty → a real clear, back to absent rather than an empty husk.
    const cleared = await updateCharacter(id, created.id, { evolution: null });
    expect(cleared).not.toHaveProperty('evolution');
  });

  it('leaves a character with no lens byte-identical to a pre-#6445 record', async () => {
    const id = await newWork();
    const created = await createCharacter(id, { name: 'Wren Calloway', lie: 'I only matter while I am useful.' });
    expect(created).not.toHaveProperty('evolution');
    const [reloaded] = await listCharacters(id);
    expect(reloaded).not.toHaveProperty('evolution');
  });

  it('rejects an unknown stage id and an unknown outcome instead of coercing them', async () => {
    const id = await newWork();
    const created = await createCharacter(id, {
      name: 'Wren Calloway',
      evolution: {
        outcome: 'triumphant',
        stages: [
          { stageId: 'not-a-stage', testedBelief: 'invented' },
          { stageId: 'cost-tested', characterChoice: 'She pays it.' },
        ],
      },
    });
    expect(created.evolution.outcome).toBeNull();
    expect(created.evolution.stages.map((s) => s.stageId)).toEqual(['cost-tested']);
  });

  it('drops a junk segment pointer but keeps a well-shaped one that no longer exists', async () => {
    const id = await newWork();
    const created = await createCharacter(id, {
      name: 'Wren Calloway',
      evolution: {
        outcome: 'full-change',
        stages: [
          { stageId: 'cost-tested', characterChoice: 'a', evidence: { segmentId: '../../etc/passwd' } },
          { stageId: 'final-proof', characterChoice: 'b', evidence: { segmentId: 'seg-999', anchorQuote: 'gone' } },
        ],
      },
    });
    const [costTested, finalProof] = created.evolution.stages;
    expect(costTested.evidence).toBeNull();
    // A well-shaped pointer at a deleted segment is PRESERVED so the review can
    // report it stale and the writer can re-anchor it.
    expect(finalProof.evidence).toMatchObject({ segmentId: 'seg-999', anchorQuote: 'gone' });
  });
});

describe('writers room — route schema and store allowlist agree', () => {
  it('accepts nothing on the wire the store would silently drop', async () => {
    const { writersRoomCharacterUpdateSchema } = await import('../../lib/pipelineValidation.js');
    // `name` is a primaryField, handled ahead of the allowlist; everything else
    // the schema accepts has to be writable, or the PATCH 200s and does nothing.
    const wireFields = Object.keys(writersRoomCharacterUpdateSchema.shape).filter((f) => f !== 'name');
    const writable = new Set(characters.CHARACTER_EDITABLE_FIELDS);
    expect(wireFields.filter((f) => !writable.has(f))).toEqual([]);
    // Regression pin for the field this slice added on both sides at once.
    expect(wireFields).toContain('evolution');
  });
});
