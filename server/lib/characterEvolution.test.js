import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EVOLUTION_OUTCOMES,
  EVOLUTION_STAGES,
  evolutionEvidenceStatus,
  isDeclaredEvolution,
  renderCharacterEvolutionForPrompt,
  sanitizeCharacterEvolution,
  sanitizeCharacterEvolutionList,
} from './characterEvolution.js';

const stage = (stageId, extra = {}) => ({ stageId, testedBelief: `belief for ${stageId}`, ...extra });

describe('sanitizeCharacterEvolution', () => {
  it('drops a lens with nothing authored, so an untouched record keeps no husk', () => {
    expect(sanitizeCharacterEvolution(null)).toBeNull();
    expect(sanitizeCharacterEvolution({})).toBeNull();
    // Every leaf present but blank — the whole lens collapses rather than
    // persisting five empty stages.
    expect(sanitizeCharacterEvolution({
      outcome: '',
      outcomeNote: '   ',
      stages: EVOLUTION_STAGES.map((stageId) => ({
        stageId, testedBelief: '', externalPressure: '', characterChoice: '', causalConsequence: '',
      })),
    })).toBeNull();
  });

  it('keeps a SPARSE lens and stores stages in canonical sequence order', () => {
    // Authored out of order, stages 1 and 3 only — the documented sparse case.
    const evolution = sanitizeCharacterEvolution({
      outcome: 'partial-open',
      stages: [stage('commitment-to-change'), stage('control-strategy-failing')],
    });
    expect(evolution.stages.map((s) => s.stageId))
      .toEqual(['control-strategy-failing', 'commitment-to-change']);
    // Idempotent: re-sanitizing the stored shape must not reorder or lose it,
    // which is what makes a save → load → sync → save round trip byte-stable.
    expect(sanitizeCharacterEvolution(evolution)).toEqual(evolution);
  });

  it('rejects an unknown stageId and an unknown outcome rather than coercing them', () => {
    const evolution = sanitizeCharacterEvolution({
      outcome: 'mostly-changed',
      outcomeNote: 'author is still deciding',
      stages: [stage('act-two-midpoint'), stage('cost-tested')],
    });
    // A fabricated declaration would let a downstream review read this arc as a
    // deliberate flat/tragic ending the author never declared.
    expect(evolution.outcome).toBeNull();
    expect(isDeclaredEvolution(evolution)).toBe(false);
    expect(evolution.stages.map((s) => s.stageId)).toEqual(['cost-tested']);
  });

  it('treats a present-but-empty stage field as a real clear, not an absent one', () => {
    const evolution = sanitizeCharacterEvolution({
      outcome: 'full-change',
      stages: [{ stageId: 'final-proof', testedBelief: '', characterChoice: 'walks away' }],
    });
    expect(evolution.stages[0]).toMatchObject({ testedBelief: '', characterChoice: 'walks away' });
  });

  it('declares a flat arc as first-class rather than an unfinished one', () => {
    const flat = sanitizeCharacterEvolution({ outcome: 'flat-testing', outcomeNote: 'she holds' });
    expect(isDeclaredEvolution(flat)).toBe(true);
    expect(flat.stages).toEqual([]);
    for (const outcome of EVOLUTION_OUTCOMES) {
      expect(isDeclaredEvolution(sanitizeCharacterEvolution({ outcome }))).toBe(true);
    }
  });
});

describe('evidence anchors', () => {
  const withAnchor = (evidence) => sanitizeCharacterEvolution({
    outcome: 'full-change',
    stages: [stage('final-proof', { evidence })],
  }).stages[0].evidence;

  it('preserves an authored pointer to a deleted record and reports it stale', () => {
    const evidence = withAnchor({ transitionId: 'trn-deleted', episodeId: 'ep-gone' });
    // Preserved as authored intent, following the sanitizeStoryOutline
    // precedent that keeps an unknown targetKey so it can be REPORTED.
    expect(evidence).toMatchObject({ transitionId: 'trn-deleted', episodeId: 'ep-gone' });
    expect(evolutionEvidenceStatus(evidence, {
      transitionIds: ['trn-alive'], episodeIds: ['ep-alive'],
    })).toBe('stale');
  });

  it('reports anchored only when every authored pointer resolves', () => {
    const evidence = withAnchor({ episodeId: 'ep-1', sceneKey: 'opening' });
    expect(evolutionEvidenceStatus(evidence, { episodeIds: ['ep-1'], sceneKeys: ['opening'] }))
      .toBe('anchored');
    // One resolvable, one not — the whole anchor is stale, never verified.
    expect(evolutionEvidenceStatus(evidence, { episodeIds: ['ep-1'], sceneKeys: ['closing'] }))
      .toBe('stale');
  });

  it('never reports anchored for absent evidence or an unchecked pointer', () => {
    expect(evolutionEvidenceStatus(null, { episodeIds: ['ep-1'] })).toBe('unanchored');
    // A pointer with no reference set to check it against is unknown, and
    // unknown must not read as verified.
    expect(evolutionEvidenceStatus(withAnchor({ episodeId: 'ep-1' }), {})).toBe('unverified');
    // A free-text scene anchor is authored but has nothing to resolve against.
    expect(evolutionEvidenceStatus(withAnchor({ atSceneAnchor: 'the pier at dawn' }), {}))
      .toBe('unverified');
  });

  it('drops a malformed pointer but keeps a well-shaped one', () => {
    // 'episode-4' is not an `ep-` id — a junk value must not masquerade as
    // evidence, which is different from a well-shaped pointer to a deleted one.
    expect(withAnchor({ episodeId: 'episode-4', atIssue: 3 }))
      .toMatchObject({ episodeId: '', atIssue: 3 });
    expect(withAnchor({ transitionId: 'not-a-transition' })).toBeNull();
  });
});

describe('sanitizeCharacterEvolutionList', () => {
  it('dedupes by character identity and drops identity-less or empty entries', () => {
    const list = sanitizeCharacterEvolutionList([
      { characterId: 'chr-1', characterName: 'Ada', evolution: { outcome: 'full-change' } },
      { characterId: 'chr-1', characterName: 'Ada Reyes', evolution: { outcome: 'tragic-refusal' } },
      { characterName: 'Bo', evolution: { outcome: 'flat-testing' } },
      { characterName: 'bo', evolution: { outcome: 'partial-open' } },
      { characterName: 'Cy', evolution: {} },
      { evolution: { outcome: 'full-change' } },
    ]);
    expect(list.map((e) => [e.characterName, e.evolution.outcome])).toEqual([
      ['Ada Reyes', 'tragic-refusal'],
      ['bo', 'partial-open'],
    ]);
  });
});

describe('renderCharacterEvolutionForPrompt', () => {
  it('names the declared outcome and never presents a stale anchor as proof', () => {
    const evolution = sanitizeCharacterEvolution({
      outcome: 'tragic-refusal',
      outcomeNote: 'he keeps the ledger',
      stages: [stage('final-proof', { characterChoice: 'burns the letter', evidence: { episodeId: 'ep-gone' } })],
    });
    const block = renderCharacterEvolutionForPrompt(evolution, { episodeIds: ['ep-live'] });
    expect(block).toContain('declared outcome: tragic-refusal — he keeps the ledger');
    expect(block).toContain('[stale]');
    expect(block).not.toContain('[anchored]');
  });

  it('returns null when there is nothing to render', () => {
    expect(renderCharacterEvolutionForPrompt(null)).toBeNull();
    expect(renderCharacterEvolutionForPrompt({ outcome: null, outcomeNote: '', stages: [] })).toBeNull();
  });
});

// The client editors read the stage/outcome vocabularies from this leaf. A
// hand-copied list there would drift the moment a stage id changed here, and an
// equality assertion on the client side cannot catch it — it would be comparing
// re-exported bindings to themselves. So assert the property that actually
// matters: the mirror IMPORTS, it does not restate.
describe('client mirror re-exports rather than copies', () => {
  it('declares no vocabulary of its own', () => {
    const mirror = readFileSync(
      join(import.meta.dirname, '../../client/src/lib/characterEvolution.js'),
      'utf8',
    );
    expect(mirror).toContain("from '../../../server/lib/characterEvolution.js'");
    for (const name of ['EVOLUTION_STAGES', 'EVOLUTION_OUTCOMES', 'EVOLUTION_STAGE_LABELS', 'CHARACTER_EVOLUTION_LIMITS']) {
      expect(mirror, `${name} must be re-exported, not redeclared`)
        .not.toMatch(new RegExp(`(const|let|var)\\s+${name}\\s*=`));
    }
  });
});

describe('quoted segment anchors (#6445)', () => {
  const quoted = (segmentId, anchorQuote) => ({ segmentId, anchorQuote });
  // A Map ref set carries the passage each pointer names; a Set carries only
  // its existence.
  const passages = new Map([
    ['seg-001', 'She balanced the books before she balanced anything else.'],
    ['seg-002', 'She let the boat go without counting what it cost her.'],
  ]);

  it('keeps a well-shaped segment pointer and drops a junk one', () => {
    const lens = sanitizeCharacterEvolution({
      outcome: 'full-change',
      stages: [
        stage('cost-tested', { evidence: quoted('seg-004', '  a  quoted   line ') }),
        stage('final-proof', { evidence: quoted('../../etc/passwd', 'x') }),
      ],
    });
    expect(lens.stages[0].evidence).toMatchObject({ segmentId: 'seg-004', anchorQuote: 'a  quoted   line' });
    // The pointer is junk, but the quote alone is still authored evidence.
    expect(lens.stages[1].evidence).toMatchObject({ segmentId: '', anchorQuote: 'x' });
  });

  it('reports anchored only when the pointer resolves AND still holds its quote', () => {
    expect(evolutionEvidenceStatus(quoted('seg-002', 'let the boat go'), { segmentIds: passages }))
      .toBe('anchored');
    // Same live pointer, quote that has moved off it — the renumbering case.
    expect(evolutionEvidenceStatus(quoted('seg-001', 'let the boat go'), { segmentIds: passages }))
      .toBe('stale');
    // Pointer gone entirely.
    expect(evolutionEvidenceStatus(quoted('seg-009', 'let the boat go'), { segmentIds: passages }))
      .toBe('stale');
  });

  it('folds whitespace and case before comparing, so a rewrap is not a drift', () => {
    expect(evolutionEvidenceStatus(quoted('seg-002', 'Let   The\nBoat  Go'), { segmentIds: passages }))
      .toBe('anchored');
  });

  it('never reports anchored when the host supplied no passage text to check', () => {
    // A Set proves the id exists and nothing more, so a QUOTED anchor stays
    // unverified rather than being credited on existence alone.
    const ids = new Set(['seg-001', 'seg-002']);
    expect(evolutionEvidenceStatus(quoted('seg-002', 'let the boat go'), { segmentIds: ids }))
      .toBe('unverified');
    // …but a dead pointer is still dead.
    expect(evolutionEvidenceStatus(quoted('seg-009', 'let the boat go'), { segmentIds: ids }))
      .toBe('stale');
    // An unquoted pointer is judged on existence, exactly like the other hosts.
    expect(evolutionEvidenceStatus({ segmentId: 'seg-002' }, { segmentIds: ids })).toBe('anchored');
  });

  it('treats a quote with no pointer as an unresolvable locator, never as unanchored', () => {
    expect(evolutionEvidenceStatus({ anchorQuote: 'let the boat go' }, { segmentIds: passages }))
      .toBe('unverified');
    expect(evolutionEvidenceStatus({}, { segmentIds: passages })).toBe('unanchored');
  });

  it('renders the segment and its quote, annotated with the derived status', () => {
    const lens = sanitizeCharacterEvolution({
      outcome: 'full-change',
      stages: [stage('final-proof', { evidence: quoted('seg-002', 'let the boat go') })],
    });
    const block = renderCharacterEvolutionForPrompt(lens, { segmentIds: passages });
    expect(block).toContain('segment seg-002');
    expect(block).toContain('quote "let the boat go"');
    expect(block).toContain('[anchored]');
  });
});
