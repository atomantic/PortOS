import { vi, afterAll } from 'vitest';
import { cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

// Isolate personal instructions so contributor config cannot decide assertions.
// Tests of global-instruction loading override this with a fixture home (#3475).
const homeStub = vi.hoisted(() => ({ dir: '/nonexistent-home-for-tests' }));

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => homeStub.dir,
}));

// Stub personal context retrieval so prompt tests never access the memory DB
// or local Digital Twin documents.
vi.mock('../memoryRetriever.js', () => ({
  getMemorySection: vi.fn().mockResolvedValue(null),
}));

vi.mock('../digital-twin.js', () => ({
  getDigitalTwinForPrompt: vi.fn().mockResolvedValue(null),
}));

vi.mock('../tools.js', () => ({
  getToolsSummaryForPrompt: vi.fn().mockResolvedValue(''),
}));

vi.mock('../provider/providers.js', () => ({
  getActiveProvider: vi.fn().mockResolvedValue(null),
}));

vi.mock('../promptRunner.js', () => ({
assertProvider: (provider, { message, code, status = 503 } = {}) => {
    if (provider) return;
    const err = new Error(message || 'No AI provider available');
    if (code) { err.status = status; err.code = code; }
    throw err;
  },
  runPromptThroughProvider: vi.fn().mockResolvedValue(null),
}));

// The app registry seeds data/apps.json on first read; keep that off the checkout's data/.
vi.mock('../../lib/paths.js', async (importOriginal) => {
  const { lazyTempDataRoot, makePathsProxy } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('agent-prompt-builder-') });
});

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { readFile } = await import('fs/promises');
  return {
    ...actual,
    // getAppWorkspace reads data/apps.json through this — mocked so the tilde
    // tests below never touch the real registry.
    readJSONFile: vi.fn(actual.readJSONFile),
    // The production install copies shipped templates into data/. This test
    // reads the committed module-hygiene template directly so the API-path
    // assembly assertion stays independent of ignored runtime state.
    tryReadFile: vi.fn(async (path, ...args) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.endsWith('/data/prompts/skills/module-hygiene.md')) {
        return readFile(`${actual.PATHS.root}/data.reference/prompts/skills/module-hygiene.md`, 'utf8')
          .catch(() => null);
      }
      return actual.tryReadFile(path, ...args);
    }),
  };
});

vi.mock('../../lib/slashdoLoader.js', async (importOriginal) => {
  const actual = await importOriginal();
  const loadFile = vi.fn().mockResolvedValue(null);
  return {
    ...actual,
    loadSlashdoFile: loadFile,
    loadSlashdoBundle: vi.fn(async (...args) => {
      const body = await loadFile(...args);
      return body == null ? null : { body, files: {} };
    }),
    loadSlashdoLib: vi.fn().mockResolvedValue(null),
    // #3110 — staging the resolved copy is real disk I/O; mocked so tests can
    // assert the pointer path without writing under data/.
    writeResolvedSlashdoBody: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../jira.js', () => ({
  createTicket: vi.fn().mockResolvedValue(null),
}));

// Code Review Defaults resolver — mocked so tests can control the install-wide
// default reviewer list threaded into buildAgentPrompt without touching disk.
// Most prompt-builder cases need an explicit reviewer to exercise their
// completion text; opt-in/empty-default cases override this fixture locally.
vi.mock('../codeReview.js', () => ({
  getCodeReviewDefaults: vi.fn().mockResolvedValue({ reviewers: ['copilot'] }),
}));

// Skill Registry index (#17387): empty by default so unrelated cases see no
// section; the dedicated case below supplies one.
const skillIndex = vi.hoisted(() => ({ build: vi.fn(async () => '') }));

vi.mock('../skills/skillService.js', () => ({ buildSkillIndexPromptSection: skillIndex.build }));

function makeTask(overrides = {}) {
  return {
    id: 'task-test-1',
    priority: 'HIGH',
    description: 'Add a button to the dashboard',
    metadata: {},
    ...overrides,
  };
}

function installPromptBuilderHooks() {
  afterAll(cleanupTempDataRoots);
}

export {
  skillIndex,
  makeTask,
  installPromptBuilderHooks,
  homeStub,
};
