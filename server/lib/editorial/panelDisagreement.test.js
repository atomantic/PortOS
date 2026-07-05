import { describe, it, expect } from 'vitest';
import {
  PANEL_PERSONAS,
  PANEL_PERSONA_IDS,
  PANEL_QUESTION_IDS,
  CONSENSUS_THRESHOLD,
  personaLabel,
  sanitizePersonaResponse,
  minePanelDisagreements,
  consensusToFindings,
  __testing,
} from './panelDisagreement.js';

// Build a persona response with the given per-question issue citations.
// `cites` maps questionId -> issue-number array; unlisted questions get a
// generic non-empty answer with no citations.
function persona(id, cites = {}) {
  const answers = {};
  for (const qid of PANEL_QUESTION_IDS) {
    answers[qid] = { text: `${id} on ${qid}`, issues: cites[qid] || [] };
  }
  return { persona: id, answers, verdict: `${id} verdict` };
}

describe('panel vocabulary', () => {
  it('has four personas whose ids match the stage-prompt suffixes', () => {
    expect(PANEL_PERSONA_IDS).toEqual(['editor', 'genre-reader', 'writer', 'first-reader']);
    expect(PANEL_PERSONAS).toHaveLength(4);
  });
  it('has ten questions including the required ids', () => {
    for (const q of ['momentum_loss', 'earned_ending', 'cut_candidate', 'missing_scene', 'thinnest_character',
      'best_scene', 'worst_scene', 'would_recommend', 'haunts_you', 'next_book']) {
      expect(PANEL_QUESTION_IDS).toContain(q);
    }
    expect(PANEL_QUESTION_IDS).toHaveLength(10);
  });
  it('labels personas', () => {
    expect(personaLabel('editor')).toBe('The Editor');
    expect(personaLabel('unknown')).toBe('unknown');
  });
});

describe('sanitizePersonaResponse', () => {
  it('normalizes a full answers object and clamps issue numbers', () => {
    const raw = {
      verdict: 'strong but slow',
      answers: {
        momentum_loss: { text: 'drags in the middle', issues: [3, 3, 4, '5', -1, 2.5, null] },
        best_scene: { answer: 'the confrontation', issues: [7] },
      },
    };
    const out = sanitizePersonaResponse('editor', raw);
    expect(out.persona).toBe('editor');
    expect(out.verdict).toBe('strong but slow');
    // dedupes, drops non-positive-integers, sorts
    expect(out.answers.momentum_loss.issues).toEqual([3, 4, 5]);
    expect(out.answers.momentum_loss.text).toBe('drags in the middle');
    // accepts `answer` alias
    expect(out.answers.best_scene.text).toBe('the confrontation');
    // every question id present even when absent from input
    for (const qid of PANEL_QUESTION_IDS) expect(out.answers[qid]).toBeDefined();
    expect(out.answers.worst_scene).toEqual({ text: '', issues: [] });
  });

  it('filters citations to the valid issue-number allow-list', () => {
    const out = sanitizePersonaResponse('writer',
      { answers: { cut_candidate: { text: 'x', issues: [2, 99, 4] } } },
      { validIssueNumbers: [1, 2, 3, 4] });
    expect(out.answers.cut_candidate.issues).toEqual([2, 4]);
  });

  it('tolerates a flat map (no answers wrapper) and string answers', () => {
    const out = sanitizePersonaResponse('first-reader', { momentum_loss: 'got bored at the end' });
    expect(out.answers.momentum_loss).toEqual({ text: 'got bored at the end', issues: [] });
  });

  it('cleanIssueNumbers dedupes, sorts, and caps', () => {
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(__testing.cleanIssueNumbers(many)).toHaveLength(12);
    expect(__testing.cleanIssueNumbers([5, 1, 5, 3])).toEqual([1, 3, 5]);
    expect(__testing.cleanIssueNumbers('nope')).toEqual([]);
  });
});

describe('minePanelDisagreements', () => {
  it('routes a ≥3-persona concern into consensus, below into attention', () => {
    const responses = [
      persona('editor', { momentum_loss: [4], cut_candidate: [2] }),
      persona('genre-reader', { momentum_loss: [4], cut_candidate: [9] }),
      persona('writer', { momentum_loss: [4] }),
      persona('first-reader', {}),
    ];
    const mined = minePanelDisagreements(responses, { validIssueNumbers: [2, 4, 9] });
    expect(mined.totalPersonas).toBe(4);
    expect(mined.consensusThreshold).toBe(CONSENSUS_THRESHOLD);

    // issue #4 momentum_loss cited by 3 personas -> consensus
    const c = mined.consensus.find((e) => e.issueNumber === 4 && e.questionId === 'momentum_loss');
    expect(c).toBeTruthy();
    expect(c.count).toBe(3);
    expect(c.personas.sort()).toEqual(['editor', 'genre-reader', 'writer']);

    // issue #2 cut_candidate cited by 1 persona -> attention (some but not all)
    const a = mined.attention.find((e) => e.issueNumber === 2 && e.questionId === 'cut_candidate');
    expect(a).toBeTruthy();
    expect(a.count).toBe(1);
    // consensus items never also appear in attention
    expect(mined.attention.some((e) => e.issueNumber === 4 && e.questionId === 'momentum_loss')).toBe(false);
  });

  it('a unanimous concern is consensus, not attention', () => {
    const responses = PANEL_PERSONA_IDS.map((id) => persona(id, { worst_scene: [5] }));
    const mined = minePanelDisagreements(responses, { validIssueNumbers: [5] });
    const c = mined.consensus.find((e) => e.issueNumber === 5 && e.questionId === 'worst_scene');
    expect(c.count).toBe(4);
    expect(mined.attention).toHaveLength(0);
  });

  it('only concern questions feed consensus/attention (evaluative ones do not)', () => {
    // earned_ending is not a concern; three personas citing it must not surface.
    const responses = [
      persona('editor', { earned_ending: [1] }),
      persona('genre-reader', { earned_ending: [1] }),
      persona('writer', { earned_ending: [1] }),
      persona('first-reader', {}),
    ];
    const mined = minePanelDisagreements(responses);
    expect(mined.consensus).toHaveLength(0);
    expect(mined.attention).toHaveLength(0);
  });

  it('detects polarizing best-vs-worst on the same issue', () => {
    const responses = [
      persona('editor', { best_scene: [7] }),
      persona('genre-reader', { worst_scene: [7] }),
      persona('writer', { best_scene: [3] }),
      persona('first-reader', {}),
    ];
    const mined = minePanelDisagreements(responses, { validIssueNumbers: [3, 7] });
    expect(mined.polarizing).toHaveLength(1);
    expect(mined.polarizing[0]).toMatchObject({ issueNumber: 7, lovedBy: ['editor'], hatedBy: ['genre-reader'] });
  });

  it('drops hallucinated issue numbers when an allow-list is given', () => {
    const responses = PANEL_PERSONA_IDS.map((id) => persona(id, { momentum_loss: [42] }));
    const mined = minePanelDisagreements(responses, { validIssueNumbers: [1, 2, 3] });
    expect(mined.consensus).toHaveLength(0);
  });

  it('respects a custom consensus threshold', () => {
    const responses = [
      persona('editor', { momentum_loss: [4] }),
      persona('genre-reader', { momentum_loss: [4] }),
      persona('writer', {}),
      persona('first-reader', {}),
    ];
    const mined = minePanelDisagreements(responses, { validIssueNumbers: [4], consensusThreshold: 2 });
    expect(mined.consensus.find((e) => e.issueNumber === 4)).toBeTruthy();
  });
});

describe('consensusToFindings', () => {
  const responses = [
    persona('editor', { momentum_loss: [4] }),
    persona('genre-reader', { momentum_loss: [4] }),
    persona('writer', { momentum_loss: [4] }),
    persona('first-reader', { momentum_loss: [4] }),
  ];

  it('maps consensus entries to seedable findings with severity by count', () => {
    const mined = minePanelDisagreements(responses, { validIssueNumbers: [4] });
    const findings = consensusToFindings(mined.consensus, responses, { totalPersonas: 4 });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.issueNumber).toBe(4);
    expect(f.checkId).toBe('reader-panel.consensus');
    expect(f.category).toBe('pacing'); // momentum_loss category
    expect(f.severity).toBe('high');   // 4/4 == all personas
    expect(f.problem).toContain('#4');
    expect(f.problem).toContain('The Editor');
  });

  it('grades a non-unanimous consensus as medium', () => {
    const three = responses.slice(0, 3);
    const mined = minePanelDisagreements(three, { validIssueNumbers: [4] });
    const findings = consensusToFindings(mined.consensus, three, { totalPersonas: 4 });
    expect(findings[0].severity).toBe('medium');
  });

  it('returns [] for empty consensus', () => {
    expect(consensusToFindings([], responses, { totalPersonas: 4 })).toEqual([]);
  });
});
