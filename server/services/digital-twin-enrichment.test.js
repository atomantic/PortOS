import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from '../lib/fileUtils.js';
import { ENRICHMENT_CATEGORIES, SCALE_QUESTIONS } from './digital-twin-constants.js';
import { generateEnrichmentQuestion, processEnrichmentAnswer } from './digital-twin-enrichment.js';
import { callProviderAI } from './digital-twin-helpers.js';
import { loadMeta, saveMeta } from './digital-twin-meta.js';
import { buildPrompt } from './promptService.js';
import { getActiveProvider, getProviderById } from './provider/providers.js';

vi.mock('fs/promises', () => ({ readFile: vi.fn(async () => '# Existing content\n') }));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: run => run() }));
vi.mock('../lib/fileUtils.js', () => ({ atomicWrite: vi.fn() }));
vi.mock('./digital-twin-analysis.js', () => ({ generateGapRecommendations: () => [] }));
vi.mock('./digital-twin-context.js', () => ({ getDigitalTwinForPrompt: async () => 'Sample context' }));
vi.mock('./digital-twin-helpers.js', () => ({
  DIGITAL_TWIN_DIR: '/example/digital-twin',
  generateId: () => 'question-id',
  now: () => '2026-01-01T00:00:00.000Z',
  ensureSoulDir: vi.fn(),
  callProviderAI: vi.fn(),
  ensureDocumentInMeta: vi.fn()
}));
vi.mock('./digital-twin-meta.js', () => ({
  loadMeta: vi.fn(),
  saveMeta: vi.fn(),
  withMetaLock: run => run(),
  digitalTwinEvents: { emit: vi.fn() }
}));
vi.mock('./promptService.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('./provider/providers.js', () => ({ getActiveProvider: vi.fn(), getProviderById: vi.fn() }));

const category = 'core_memories';
const { targetDoc, questions } = ENRICHMENT_CATEGORIES[category];
const providerId = 'sample-provider';
const disabledProvider = { id: providerId, enabled: false, defaultModel: 'sample-model' };
const entry = { category, question: 'What did you build?', answer: 'A sample project.' };

beforeEach(() => {
  vi.clearAllMocks();
  loadMeta.mockResolvedValue({
    enrichment: {
      completedCategories: [],
      questionsAnswered: { [category]: questions.length },
      scaleQuestionsAnswered: Object.fromEntries(SCALE_QUESTIONS.map(({ id }) => [id, 3]))
    }
  });
  buildPrompt.mockResolvedValue('Sample prompt');
  callProviderAI.mockResolvedValue({ text: 'Sample generated text' });
  getActiveProvider.mockResolvedValue(disabledProvider);
  getProviderById.mockResolvedValue(disabledProvider);
});

describe('Digital Twin enrichment provider admission', () => {
  it.each([
    [providerId, `Provider ${providerId} not found or disabled`],
    [undefined, 'No enabled AI provider available']
  ])('refuses to generate a question using a disabled provider (override %s)', async (override, message) => {
    await expect(generateEnrichmentQuestion(category, override)).rejects.toThrow(message);
    expect(callProviderAI).not.toHaveBeenCalled();
  });

  it('refuses an explicit disabled provider before processing or saving an answer', async () => {
    await expect(processEnrichmentAnswer({ ...entry, providerOverride: providerId }))
      .rejects.toThrow(`Provider ${providerId} not found or disabled`);
    expect(getActiveProvider).not.toHaveBeenCalled();
    expect(callProviderAI).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('persists raw markdown when the active provider is disabled', async () => {
    const rawMarkdown = '### What did you build?\n\nA sample project.\n\n';

    await expect(processEnrichmentAnswer(entry)).resolves.toMatchObject({ targetDoc, contentAdded: rawMarkdown });
    expect(callProviderAI).not.toHaveBeenCalled();
    expect(atomicWrite).toHaveBeenCalledWith(
      `/example/digital-twin/${targetDoc}`, `# Existing content\n\n${rawMarkdown}`, { mode: 0o600, dirMode: 0o700 }
    );
    expect(saveMeta).toHaveBeenCalledOnce();
  });
});
