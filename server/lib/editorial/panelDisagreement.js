/**
 * Reader-panel disagreement mining (#2170, CWQE Phase 6).
 *
 * Four reader personas (The Editor, The Genre Reader, The Writer, The First
 * Reader) each read a condensed arc digest of a series and answer the same set
 * of qualitative questions, citing issue numbers. The editorial signal lives in
 * where they DISAGREE — an issue flagged by one persona but loved by another is
 * a deliberate trade-off surfaced for the human; an issue flagged by 3+ personas
 * is a real problem that should enter the normal manuscript-review triage flow.
 *
 * This module is PURE (matches the directory contract): it defines the persona /
 * question vocabulary, sanitizes a persona's raw LLM answer into a stable shape,
 * mines the cross-persona (dis)agreement, and shapes consensus findings for
 * `seedReviewFromFindings`. All I/O (digest build, LLM calls, snapshot storage)
 * lives in `server/services/pipeline/readerPanel.js`.
 */

// The four personas, in render order. `id` is the stable machine key (also the
// stage-prompt suffix `pipeline-panel-<id>.md`); `label` is the human name.
export const PANEL_PERSONAS = Object.freeze([
  { id: 'editor', label: 'The Editor', blurb: 'Senior editor — prose texture, subtext, over-explaining.' },
  { id: 'genre-reader', label: 'The Genre Reader', blurb: 'Reads 50 novels a year — pacing and page-turn pull.' },
  { id: 'writer', label: 'The Writer', blurb: 'Craft — structure, beats, foreshadowing payoff.' },
  { id: 'first-reader', label: 'The First Reader', blurb: 'No craft vocabulary — pure emotional response.' },
]);

export const PANEL_PERSONA_IDS = Object.freeze(PANEL_PERSONAS.map((p) => p.id));

const PERSONA_LABEL = new Map(PANEL_PERSONAS.map((p) => [p.id, p.label]));
export const personaLabel = (id) => PERSONA_LABEL.get(id) || id;

/**
 * The ~10 qualitative questions every persona answers. `concern: true` marks a
 * question whose cited issues are a *flag* (something wrong there) — those feed
 * disagreement mining + consensus findings. `positive` questions (best/haunts)
 * feed the "polarizing" cross-signal instead. `evaluative` questions are read by
 * humans in the panel view but not mined into findings.
 */
export const PANEL_QUESTIONS = Object.freeze([
  { id: 'momentum_loss', label: 'Where momentum is lost', concern: true, category: 'pacing', prompt: 'Where does the story lose momentum or drag? Cite the issue number(s).' },
  { id: 'earned_ending', label: 'Is the ending earned', concern: false, category: 'structure', prompt: 'Does the ending feel earned by what came before? Cite the issue number(s) that set it up or undercut it.' },
  { id: 'cut_candidate', label: 'What to cut', concern: true, category: 'pacing', prompt: 'What could be cut with no loss (or a gain)? Cite the issue number(s).' },
  { id: 'missing_scene', label: 'A missing scene', concern: true, category: 'structure', prompt: 'What scene is missing that the story needs? Cite the issue number(s) it belongs near.' },
  { id: 'thinnest_character', label: 'The thinnest character', concern: true, category: 'character', prompt: 'Which character is thinnest / least realized? Name them and cite the issue number(s) where it shows.' },
  { id: 'best_scene', label: 'The best scene', concern: false, category: 'structure', prompt: 'What is the single best scene / moment? Cite the issue number.' },
  { id: 'worst_scene', label: 'The worst scene', concern: true, category: 'structure', prompt: 'What is the weakest scene / moment? Cite the issue number.' },
  { id: 'would_recommend', label: 'Would recommend', concern: false, category: 'other', prompt: 'Would you recommend this to a friend, and why or why not? Cite the issue number(s) that decided it.' },
  { id: 'haunts_you', label: 'What haunts you', concern: false, category: 'other', prompt: 'What image, line, or moment haunts you after finishing? Cite the issue number.' },
  { id: 'next_book', label: 'Read the next book', concern: false, category: 'other', prompt: 'Would you read the next book in the series, and what would make you? Cite the issue number(s).' },
]);

export const PANEL_QUESTION_IDS = Object.freeze(PANEL_QUESTIONS.map((q) => q.id));
const QUESTION_BY_ID = new Map(PANEL_QUESTIONS.map((q) => [q.id, q]));
const CONCERN_QUESTION_IDS = PANEL_QUESTIONS.filter((q) => q.concern).map((q) => q.id);

// A concern flagged by this many distinct personas (of the four) is treated as a
// real problem and routed into manuscript-review findings. Below it (but flagged
// by at least one and not all) it's "editorial attention" — surfaced for the
// human, not auto-routed.
export const CONSENSUS_THRESHOLD = 3;

const ANSWER_TEXT_MAX = 1500;
const VERDICT_MAX = 600;
const MAX_ISSUES_PER_ANSWER = 12;
const PROBLEM_MAX = 1900;

const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Accept an array of issue numbers the persona cited; keep valid positive
// integers, dedupe, cap. Optionally intersect with the known series issue
// numbers so a hallucinated citation never reaches the findings store.
function cleanIssueNumbers(raw, validSet) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (validSet && !validSet.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_ISSUES_PER_ANSWER) break;
  }
  return out.sort((a, b) => a - b);
}

/**
 * Sanitize one persona's raw LLM answer object into the stored shape:
 *   { persona, answers: { <qid>: { text, issues:[int] } }, verdict }
 * Every question id is present (missing answers become empty) so the miner and
 * the UI can iterate a stable set. `validIssueNumbers` (optional) filters cited
 * numbers to the series' real issues.
 */
export function sanitizePersonaResponse(personaId, raw, { validIssueNumbers = null } = {}) {
  const validSet = Array.isArray(validIssueNumbers) ? new Set(validIssueNumbers) : null;
  const src = raw && typeof raw === 'object' ? (raw.answers && typeof raw.answers === 'object' ? raw.answers : raw) : {};
  const answers = {};
  for (const qid of PANEL_QUESTION_IDS) {
    const a = src[qid];
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      answers[qid] = { text: cleanStr(a.text ?? a.answer, ANSWER_TEXT_MAX), issues: cleanIssueNumbers(a.issues ?? a.issueNumbers, validSet) };
    } else if (typeof a === 'string') {
      answers[qid] = { text: cleanStr(a, ANSWER_TEXT_MAX), issues: [] };
    } else {
      answers[qid] = { text: '', issues: [] };
    }
  }
  return {
    persona: personaId,
    answers,
    verdict: cleanStr(raw?.verdict ?? raw?.summary, VERDICT_MAX),
  };
}

// Build `Map<issueNumber, Set<personaId>>` of who cited each issue for one
// question across the panel.
function citationsForQuestion(responses, qid) {
  const map = new Map();
  for (const r of responses) {
    const cited = r?.answers?.[qid]?.issues;
    if (!Array.isArray(cited)) continue;
    for (const n of cited) {
      let set = map.get(n);
      if (!set) { set = new Set(); map.set(n, set); }
      set.add(r.persona);
    }
  }
  return map;
}

const sortEntries = (arr) => arr.sort((a, b) => (b.count - a.count) || (a.issueNumber - b.issueNumber) || a.questionId.localeCompare(b.questionId));

/**
 * Mine the panel for disagreement. Returns:
 *   - `consensus`: concern citations agreed by ≥ CONSENSUS_THRESHOLD personas
 *     (routed to findings by `consensusToFindings`).
 *   - `attention`: concern citations by SOME but not all personas, below the
 *     consensus bar — surfaced for the human as a judgment call.
 *   - `polarizing`: issues one persona named their BEST scene while another named
 *     their WORST — the sharpest single-issue disagreements.
 * `totalPersonas` echoes how many responses fed the mine (the "all" denominator).
 */
export function minePanelDisagreements(responses, { validIssueNumbers = null, consensusThreshold = CONSENSUS_THRESHOLD } = {}) {
  const list = Array.isArray(responses) ? responses.filter((r) => r && typeof r === 'object' && r.persona) : [];
  const validSet = Array.isArray(validIssueNumbers) ? new Set(validIssueNumbers) : null;
  const totalPersonas = list.length;

  const consensus = [];
  const attention = [];
  for (const qid of CONCERN_QUESTION_IDS) {
    const q = QUESTION_BY_ID.get(qid);
    const cites = citationsForQuestion(list, qid);
    for (const [issueNumber, personaSet] of cites) {
      if (validSet && !validSet.has(issueNumber)) continue;
      const count = personaSet.size;
      if (count < 1) continue;
      const entry = {
        questionId: qid,
        questionLabel: q.label,
        category: q.category,
        issueNumber,
        personas: [...personaSet],
        count,
      };
      if (count >= consensusThreshold) consensus.push(entry);
      else if (count < totalPersonas) attention.push(entry);
    }
  }

  // Polarizing: best_scene vs worst_scene on the same issue.
  const loved = citationsForQuestion(list, 'best_scene');
  const hated = citationsForQuestion(list, 'worst_scene');
  const polarizing = [];
  for (const [issueNumber, lovedBy] of loved) {
    if (validSet && !validSet.has(issueNumber)) continue;
    const hatedBy = hated.get(issueNumber);
    if (hatedBy && hatedBy.size) {
      polarizing.push({ issueNumber, lovedBy: [...lovedBy], hatedBy: [...hatedBy] });
    }
  }
  polarizing.sort((a, b) => a.issueNumber - b.issueNumber);

  return {
    totalPersonas,
    consensusThreshold,
    consensus: sortEntries(consensus),
    attention: sortEntries(attention),
    polarizing,
  };
}

/**
 * Shape consensus entries into `seedReviewFromFindings` findings. A concern
 * agreed by every persona is `high`; one merely at/above the consensus bar is
 * `medium`. `problem` names the agreeing personas and folds in a short quote from
 * each so the triage view shows WHY it was flagged.
 */
export function consensusToFindings(consensus, responses, { checkId = 'reader-panel.consensus', totalPersonas } = {}) {
  const list = Array.isArray(responses) ? responses : [];
  const byPersona = new Map(list.map((r) => [r.persona, r]));
  const denom = Number.isInteger(totalPersonas) ? totalPersonas : list.length;
  const findings = [];
  for (const entry of Array.isArray(consensus) ? consensus : []) {
    const names = entry.personas.map(personaLabel).join(', ');
    const snippets = entry.personas
      .map((pid) => {
        const text = byPersona.get(pid)?.answers?.[entry.questionId]?.text;
        return text ? `${personaLabel(pid)}: “${text.slice(0, 220)}”` : '';
      })
      .filter(Boolean)
      .join(' ');
    const lead = `Reader panel (${entry.count}/${denom}: ${names}) agree on "${entry.questionLabel}" at issue #${entry.issueNumber}.`;
    findings.push({
      severity: entry.count >= denom ? 'high' : 'medium',
      category: entry.category,
      problem: `${lead}${snippets ? ` ${snippets}` : ''}`.slice(0, PROBLEM_MAX),
      issueNumber: entry.issueNumber,
      checkId,
    });
  }
  return findings;
}

export const __testing = { cleanIssueNumbers, citationsForQuestion };
