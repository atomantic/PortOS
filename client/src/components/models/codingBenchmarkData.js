// Published score and cost pairs only. Keep these snapshots outside the composite
// comparison catalog: a coding result is not a general Intelligence Index anchor.
const cursor = 'https://cursor.com/evals';
const antigravity = 'https://artificialanalysis.ai/agents/coding-agents/comparisons/antigravity-cli-vs-codex';
const claudeCode = 'https://artificialanalysis.ai/agents/coding-agents/comparisons/codex-vs-claude-code';

function results({ model, harness, source, variant }, observations) {
  return observations.map(([effort, score, usd]) => ({
    id: [harness, model, variant, effort].filter(Boolean).join(':'),
    model, harness, source, variant, effort, score, usd,
  }));
}

const inCursor = (model, rows) => results({ model, harness: 'Cursor', source: cursor }, rows);
const inAntigravity = (model, rows) => results({ model, harness: 'Antigravity CLI', source: antigravity }, rows);
const inCodex = (model, rows) => results({ model, harness: 'Codex', source: claudeCode }, rows);
const inClaude = (model, rows) => results({ model, harness: 'Claude Code', source: claudeCode, variant: 'Default fallback' }, rows);

export const CODING_BENCHMARKS = [
  {
    id: 'cursorbench-4.1',
    name: 'CursorBench 4.1',
    sourceName: 'Cursor',
    source: cursor,
    checkedOn: '2026-11-23',
    scoreLabel: 'CursorBench 4.1 score (%)',
    scoreDecimals: 1,
    scoreSuffix: '%',
    description: 'Multi-file coding tasks from real Cursor sessions. Results compare reasoning efforts in Cursor, not in the native model CLIs.',
    rows: [
      ...inCursor('Gemini 4 Argon', [['Low', 47.9, 7.96], ['Medium', 55.8, 7.64], ['High', 56.5, 9.14]]),
      ...inCursor('Gemini 4 Carbon', [['Low', 55.0, 8.64], ['Medium', 60.4, 7.22], ['High', 61.5, 8.52]]),
      ...inCursor('Gemini 4 Hydrogen', [['Low', 23.9, 0.28], ['Medium', 46.4, 1.28], ['High', 57.3, 4.57], ['Extra High', 61.4, 8.09]]),
      ...inCursor('Gemini 4 Neon', [['Low', 45.5, 1.26], ['Medium', 57.7, 3.07], ['High', 63.7, 6.54], ['Extra High', 65.4, 10.67]]),
      ...inCursor('Claude Fable 5.2', [['Low', 53.4, 4.26], ['Medium', 54.2, 5.01], ['High', 56.5, 10.51], ['Extra High', 58.8, 17.84], ['Max', 61.3, 48.11]]),
      ...inCursor('Claude Opus 5.5', [['Low', 42.7, 1.43], ['Medium', 50.0, 2.85], ['High', 54.5, 3.87], ['Extra High', 56.7, 6.54], ['Max', 58.1, 11.88]]),
    ],
  },
  {
    id: 'aa-coding-agent-2.1',
    name: 'Artificial Analysis Coding Agent Index v2.1',
    sourceName: 'Artificial Analysis',
    source: antigravity,
    checkedOn: '2026-11-23',
    scoreLabel: 'Coding Agent Index v2.1',
    scoreDecimals: 0,
    scoreSuffix: '',
    description: 'A composite of FrontierCode-AA 2.0, Terminal-Bench 4.1, and SWE-Atlas-QnA-AA. Each result is for the model and agent setup named in the row.',
    rows: [
      ...inAntigravity('Gemini 4 Argon', [['High', 45, 13.67]]),
      ...inAntigravity('Gemini 4 Carbon', [['High', 55, 9.75]]),
      ...inAntigravity('Gemini 4 Hydrogen', [['Extra High', 52, 4.45]]),
      ...inAntigravity('Gemini 4 Neon', [['Extra High', 59, 6.86]]),
      ...inCodex('GPT-6.2 Astra', [['Low', 36, 0.70], ['Medium', 49, 1.20], ['High', 52, 2.37], ['Extra High', 53, 3.20], ['Max', 53, 5.12]]),
      ...inCodex('GPT-6.2 Sol', [['Low', 37, 0.33], ['Medium', 45, 0.57], ['High', 47, 0.76], ['Extra High', 50, 0.90], ['Max', 49, 1.22]]),
      ...inClaude('Claude Fable 5.2', [['Low', 48, 2.49], ['Medium', 53, 2.89], ['High', 58, 7.51], ['Extra High', 58, 15.47], ['Max', 56, 44.22]]),
      ...inClaude('Claude Opus 5.5', [['Max', 58, 12.61]]),
      ...inClaude('Claude Sonnet 5.5', [['Max', 56, 11.40]]),
    ],
  },
];
