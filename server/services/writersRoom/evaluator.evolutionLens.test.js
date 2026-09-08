/**
 * The Writers Room `evaluate` pass reads the OPTIONAL five-stage evolution lens
 * (#6445, epic #6418) against the manuscript it is already reviewing — WITHOUT
 * promoting the work to a Pipeline series.
 *
 * The behavior this file exists to pin, in order of how badly it fails:
 *   1. A segment anchor that no longer names the passage it was written for is
 *      STALE. `segmentIndex` is rebuilt on every draft save, so "the id still
 *      exists" is not proof; get this wrong and every save silently verifies a
 *      lens against the wrong chapter.
 *   2. A work with no lens produces the same analysis it did before the feature.
 *   3. No Series / Issue / universe record is created at any point.
 *
 * Synthetic manuscripts only — never a real instance record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});
vi.mock('../aiProvider.js', () => ({ stripCodeFences: (s) => String(s ?? '') }));
vi.mock('../stageRunner.js', () => ({ runStagedLLM: vi.fn() }));
vi.mock('../bibleExtractor.js', () => ({ extractBible: vi.fn() }));
vi.mock('../sceneExtractor.js', () => ({ extractScenes: vi.fn(), SOURCE_KIND: { PROSE: 'prose' } }));
vi.mock('../mediaCollections.js', () => ({ addItem: vi.fn(), ERR_DUPLICATE: 'DUP' }));

const { runStagedLLM } = await import('../stageRunner.js');
const { runAnalysis } = await import('./evaluator.js');
const { createWork, saveDraftBody } = await import('./local.js');
const { createCharacter, updateCharacter } = await import('./characters.js');

const EVALUATE_JSON = JSON.stringify({
  logline: 'A salvager stops keeping score.',
  summary: 'She works the harbor.',
  themes: [], strengths: [], issues: [], suggestions: [],
});

// `# Ledger` is seg-001, `# Harbor` is seg-002.
const MANUSCRIPT = [
  '# Ledger',
  '',
  'She balanced the books before she balanced anything else.',
  '',
  '# Harbor',
  '',
  'She let the boat go without counting what it cost her.',
  '',
].join('\n');

const stage = (stageId, evidence, extra = {}) => ({
  stageId,
  characterChoice: 'She lets the boat go.',
  evidence,
  ...extra,
});

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-evolution-lens-'));
  vi.mocked(runStagedLLM).mockReset();
  vi.mocked(runStagedLLM).mockResolvedValue({ content: EVALUATE_JSON, model: 'test-model', providerId: 'test-provider' });
});
afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function seedWork(body = MANUSCRIPT) {
  const work = await createWork({ title: 'Example Work', kind: 'short-story' });
  await saveDraftBody(work.id, body);
  return work.id;
}

const lastVariables = () => vi.mocked(runStagedLLM).mock.calls.at(-1)[1];

describe('writers room evaluate — five-stage evolution lens (#6445)', () => {
  it('renders an authored lens beside the framework block, anchored to this draft', async () => {
    const workId = await seedWork();
    await createCharacter(workId, {
      name: 'Wren Calloway',
      lie: 'I only matter while the ledger balances.',
      evolution: {
        outcome: 'full-change',
        outcomeNote: 'She stops keeping score.',
        stages: [stage('final-proof', { segmentId: 'seg-002', anchorQuote: 'let the boat go' })],
      },
    });

    await runAnalysis(workId, { kind: 'evaluate' });

    const variables = lastVariables();
    expect(variables.characterEvolution).toContain('- Wren Calloway');
    expect(variables.characterEvolution).toContain('declared outcome: full-change');
    expect(variables.characterEvolution).toContain('[anchored]');
    // The framework block is unchanged and still rendered alongside it.
    expect(JSON.parse(variables.castFrameworkJson)[0].lie)
      .toBe('I only matter while the ledger balances.');
  });

  it('omits the variable entirely when nobody has authored a lens', async () => {
    const workId = await seedWork();
    await createCharacter(workId, { name: 'Wren Calloway', lie: 'I only matter while the ledger balances.' });

    const analysis = await runAnalysis(workId, { kind: 'evaluate' });

    const variables = lastVariables();
    expect(variables).not.toHaveProperty('characterEvolution');
    // …and the snapshot the writer sees is exactly the pre-#6445 shape.
    expect(analysis.status).toBe('succeeded');
    expect(analysis.result).toEqual(JSON.parse(EVALUATE_JSON));
  });

  it('marks a stage stale — keeping its prose — once the draft edit deletes its segment', async () => {
    const workId = await seedWork();
    await createCharacter(workId, {
      name: 'Wren Calloway',
      evolution: {
        outcome: 'full-change',
        stages: [stage('final-proof', { segmentId: 'seg-002', anchorQuote: 'let the boat go' })],
      },
    });

    await runAnalysis(workId, { kind: 'evaluate' });
    expect(lastVariables().characterEvolution).toContain('[anchored]');

    // The writer cuts the closing chapter. `seg-002` no longer exists.
    await saveDraftBody(workId, '# Ledger\n\nShe balanced the books before she balanced anything else.\n');
    await runAnalysis(workId, { kind: 'evaluate' });

    const block = lastVariables().characterEvolution;
    expect(block).toContain('[stale]');
    expect(block).not.toContain('[anchored]');
    expect(block).toContain('choice: She lets the boat go.');
  });

  it('marks a stage stale when a new chapter renumbers its segment onto other prose', async () => {
    const workId = await seedWork();
    await createCharacter(workId, {
      name: 'Wren Calloway',
      evolution: {
        outcome: 'full-change',
        stages: [stage('final-proof', { segmentId: 'seg-002', anchorQuote: 'let the boat go' })],
      },
    });

    // A prologue pushes every heading down one. `seg-002` still RESOLVES — it
    // now covers the old first chapter — so only the quote catches the drift.
    await saveDraftBody(workId, `# Prologue\n\nThe harbor master kept his own ledger.\n\n${MANUSCRIPT}`);
    await runAnalysis(workId, { kind: 'evaluate' });

    expect(lastVariables().characterEvolution).toContain('[stale]');
    expect(lastVariables().characterEvolution).not.toContain('[anchored]');
  });

  it('carries a declared tragic-refusal / flat-testing ending through as a declaration', async () => {
    const workId = await seedWork();
    await createCharacter(workId, {
      name: 'Dov Marchetti',
      evolution: {
        outcome: 'tragic-refusal',
        outcomeNote: 'He balances the ledger one last time.',
        stages: [stage('cost-tested', { segmentId: 'seg-001', anchorQuote: 'balanced the books' })],
      },
    });
    await createCharacter(workId, {
      name: 'Ilsa Renn',
      evolution: {
        outcome: 'flat-testing',
        stages: [stage('final-proof', { segmentId: 'seg-002', anchorQuote: 'let the boat go' })],
      },
    });

    await runAnalysis(workId, { kind: 'evaluate' });

    const block = lastVariables().characterEvolution;
    expect(block).toContain('declared outcome: tragic-refusal — He balances the ledger one last time.');
    expect(block).toContain('declared outcome: flat-testing');
  });

  it('keeps analysis snapshots pinned to the draft contentHash across a lens edit', async () => {
    const workId = await seedWork();
    const character = await createCharacter(workId, {
      name: 'Wren Calloway',
      evolution: { outcome: 'partial-open', stages: [stage('cost-tested', { segmentId: 'seg-001' })] },
    });
    const first = await runAnalysis(workId, { kind: 'evaluate' });

    // Editing the lens does not touch the draft, so a re-run pins the same hash.
    await updateCharacter(workId, character.id, {
      evolution: { outcome: 'full-change', stages: [stage('final-proof', { segmentId: 'seg-002' })] },
    });
    const second = await runAnalysis(workId, { kind: 'evaluate' });

    expect(second.sourceContentHash).toBe(first.sourceContentHash);
    expect(second.draftVersionId).toBe(first.draftVersionId);
    expect(second.id).toBe('evaluate');
  });

  it('never promotes the work — no series, issue or universe record is created', async () => {
    const workId = await seedWork();
    await createCharacter(workId, {
      name: 'Wren Calloway',
      evolution: {
        outcome: 'full-change',
        stages: [stage('final-proof', { segmentId: 'seg-002', anchorQuote: 'let the boat go' })],
      },
    });

    await runAnalysis(workId, { kind: 'evaluate' });

    // The lens is reviewed AS A WRITERS ROOM WORK: the only thing this pass may
    // write is the work's own tree.
    expect(readdirSync(tempRoot).sort()).toEqual(['writers-room']);
  });
});

/**
 * The five validation scenarios in #6418 are editorial JUDGEMENTS — no
 * deterministic test can decide whether a model flagged a tragic refusal as a
 * flat arc. What IS deterministic, and what actually decides those verdicts, is
 * whether the shipped template carries the ruling for each one. This pins the
 * rulings; the prompt-migration tests pin that installs receive them.
 */
describe('shipped writers-room-evaluate template — lens rulings', () => {
  const body = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../data.reference/prompts/stages/writers-room-evaluate.md'),
    'utf-8',
  );

  it('gates the whole block on an authored lens, so a work without one is unchanged', () => {
    expect(body).toContain('{{#characterEvolution}}');
    expect(body).toContain('{{/characterEvolution}}');
    expect(body).toContain('{{characterEvolution}}');
  });

  it('rules each declared outcome, including the two that are intended endings', () => {
    // 1. earned full transformation — behavioral proof, not an external win.
    expect(body).toMatch(/`full-change`[\s\S]{0,400}behavioral proof/);
    // 2. tragic refusal — not a flat/failed arc.
    expect(body).toMatch(/`tragic-refusal`[\s\S]{0,400}Do not flag it as a flat or failed arc/);
    // 3. deliberate flat/testing — constancy is the point.
    expect(body).toMatch(/`flat-testing`[\s\S]{0,400}do not flag it as a flat arc/);
    // 4. partial/open — incompleteness is not a finding.
    expect(body).toMatch(/`partial-open`[\s\S]{0,400}Incompleteness itself is NOT an issue/);
    // 5. external victory with no behavioral proof IS a finding.
    expect(body).toContain('defeating an external obstacle');
    // An undeclared lens is provisional planning, not a declared flat arc.
    expect(body).toMatch(/`undeclared`[\s\S]{0,200}provisional planning/);
  });

  it('refuses to read a stale or unverified anchor as proof', () => {
    expect(body).toContain('[stale]');
    expect(body).toContain('[unverified]');
    expect(body).toContain('NOT PROVEN');
  });

  it('keeps the two failure modes separate, with different repairs', () => {
    expect(body).toContain('No authored intent:');
    expect(body).toContain('Authored intent not delivered:');
    expect(body).toContain('never merge them into one issue');
  });

  it('states the non-negotiables that keep the lens from becoming a gate', () => {
    expect(body).toContain('OPTIONAL');
    expect(body).toContain('NOT a page count, a chapter count, or a percentage layout');
    expect(body).toContain('Not every character transforms');
    expect(body).toContain('a character with no lens is judged exactly as they were before');
  });
});
