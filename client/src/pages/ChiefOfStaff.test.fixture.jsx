import { expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Regression coverage for #2519 — the page-level Force Evaluate handler must
// only toast success after the request resolves, and must toast the error
// (not a success) when it rejects.
vi.mock('../hooks/useAssignableInstances', () => ({ default: () => ({ instances: [], isFederated: false }) }));

const api = vi.hoisted(() => ({
  getCosStatus: vi.fn(),
  getCosSchedule: vi.fn(),
  triggerCosOnDemandTask: vi.fn(),
  getInstanceFeatures: vi.fn(),
  getCosTasks: vi.fn(),
  getCosTask: vi.fn(),
  getCosAgents: vi.fn(),
  getCosHealth: vi.fn(),
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getCosLearningSummary: vi.fn(),
  getCosActionableInsights: vi.fn(),
  getCosBudgetUsage: vi.fn(),
  getPersistentMind: vi.fn(),
  forceCosEvaluate: vi.fn(),
  updateCosTask: vi.fn(),
  pauseCos: vi.fn(),
  resumeCos: vi.fn(),
  forceHealthCheck: vi.fn(),
  updateCosConfig: vi.fn(),
  // HealthTab (rendered by the manual "Run Check" test) + its ProviderStatusCard.
  getCosTodayActivity: vi.fn(),
  getCosLearning: vi.fn(),
  getProviderStatuses: vi.fn(),
  // TasksTab + TaskAddForm, rendered by the task-event tests below.
  getCosLearningDurations: vi.fn(),
  getCosPopularTemplates: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
  getRiggedAvatars: vi.fn(),
  // AgentsTab, reached by the mobile-select navigation test below.
  getCosCompletedAgents: vi.fn(),
  getCosPendingAgentFeedback: vi.fn(),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

const socketStub = vi.hoisted(() => {
  const listeners = new Map();
  return {
    connected: false,
    on: vi.fn((event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    }),
    off: vi.fn((event, listener) => listeners.get(event)?.delete(listener)),
    emit: vi.fn(),
    receive: (event, payload) => listeners.get(event)?.forEach(listener => listener(payload)),
    resetListeners: () => listeners.clear(),
  };
});

const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
}));

vi.mock('../services/apiAgents.js', () => ({
  getCosStatus: api.getCosStatus,
  getCosSchedule: api.getCosSchedule,
  triggerCosOnDemandTask: api.triggerCosOnDemandTask,
  getCosTasks: api.getCosTasks,
  getCosTask: api.getCosTask,
  getCosAgents: api.getCosAgents,
  getCosHealth: api.getCosHealth,
  getCosLearningSummary: api.getCosLearningSummary,
  getCosActionableInsights: api.getCosActionableInsights,
  getCosBudgetUsage: api.getCosBudgetUsage,
  getPersistentMind: api.getPersistentMind,
  forceCosEvaluate: api.forceCosEvaluate,
  updateCosTask: api.updateCosTask,
  pauseCos: api.pauseCos,
  resumeCos: api.resumeCos,
  forceHealthCheck: api.forceHealthCheck,
  updateCosConfig: api.updateCosConfig,
  getCosTodayActivity: api.getCosTodayActivity,
  getCosLearning: api.getCosLearning,
  getCosLearningDurations: api.getCosLearningDurations,
  getCosPopularTemplates: api.getCosPopularTemplates,
  getCosCompletedAgents: api.getCosCompletedAgents,
  getCosPendingAgentFeedback: api.getCosPendingAgentFeedback,
}));

vi.mock('../services/apiProviders.js', () => ({
  getProviders: api.getProviders,
  getProviderStatuses: api.getProviderStatuses,
}));

vi.mock('../services/apiApps.js', () => ({ getApps: api.getApps }));

vi.mock('../services/apiCodeReview.js', () => ({ getCodeReviewDefaults: api.getCodeReviewDefaults }));

vi.mock('../services/apiAvatar.js', () => ({ getRiggedAvatars: api.getRiggedAvatars }));

// useInstanceFeatures reads apiSystem.js directly, not the api barrel (#16562).
vi.mock('../services/apiSystem.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getInstanceFeatures: api.getInstanceFeatures,
}));

vi.mock('../services/apiLocalLlm', () => localLlm);

// The Config tab's embeddings notice reads the shared settings.embeddings backend (#18296).
vi.mock('../services/apiMemory', async (importOriginal) => ({
  ...(await importOriginal()),
  getEmbeddingConfig: async () => ({ source: 'settings', provider: 'ollama', model: 'nomic-embed-text', endpoint: null, disabled: false }),
}));

vi.mock('../components/ui/Toast', () => ({ default: toast }));

vi.mock('../services/socket', () => ({ default: socketStub }));

// TaskAddForm drags in the reviewer/model picker plumbing (local-LLM status,
// prompt templates) that the task-event tests below have no stake in.
vi.mock('../components/cos/TaskAddForm', () => ({
  default: ({ onTaskAdded }) => <button type="button" onClick={() => onTaskAdded?.({
    id: 'task-immediate', description: 'Appears without a refresh', status: 'pending', metadata: {},
  }, { position: 'bottom' })}>Add test task</button>,
}));

// ConfigTab's provider/model hook fetches over the network — stub it.
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [],
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    selectedProviderId: '',
    selectedModel: '',
  }),
}));

// The rigged avatar stage pulls three.js through a lazy chunk — stub the
// module so this suite asserts the wiring (variant + coverage reach the
// stage), not the 3D render.
vi.mock('../components/cos/MiniCharacterCoSAvatar', () => ({
  default: ({ variant, coverage }) => (
    <div
      data-testid="rigged-avatar"
      data-variant={variant}
      data-covered={(coverage?.coveredStates || []).join(',')}
    />
  ),
}));

vi.mock('../components/cos/tabs/MindTab', () => ({
  default: () => <div data-testid="mind-tab">Mind</div>,
}));

const { default: ChiefOfStaff } = await import('./ChiefOfStaff');

const config = {
  avatarStyle: 'svg',
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  autoStart: false,
  improvementEnabled: true,
  idleReviewEnabled: true,
};

// `shouldAdvanceTime` keeps the clock ticking on its own so testing-library's
// `waitFor`/`findBy*` — which poll on a (now faked) interval and do not know how
// to pump vitest's clock — still resolve, while `advanceTimersByTimeAsync` can
// still jump a timer window instantly instead of sleeping through it.
const withFakeTimers = () => vi.useFakeTimers({ shouldAdvanceTime: true });

const renderPageAt = (tab) => render(
  <MemoryRouter initialEntries={[`/cos/${tab}`]}>
    <Routes>
      <Route path="/cos/:tab/:agentId?" element={<ChiefOfStaff />} />
    </Routes>
  </MemoryRouter>,
);

// #5857 — the page fans out several mocked reads on mount and each resolution
// is its own macrotask, so a bare `findBy*` straight after render polls blind
// through that whole chain. Under a contended worker it ran past testing-
// library's async budget and flaked, while passing in isolation. The page
// already publishes an exact settle signal — the loading branch's busy region
// (asserted by `ChiefOfStaff loading skeleton` below) — so wait for that to
// clear and let the following query spend its budget on one render instead of
// the entire mount. Raising `asyncUtilTimeout` / lowering `maxWorkers` was
// already spent on this file twice (#3474, client/vitest.config.js); the fix
// is to settle, not to buy more budget.
//
// Every test that reaches into a tab's contents mounts through here. Only the
// loading-skeleton guards below call `renderPageAt` bare — they hold a core
// read open precisely so the busy branch is what renders, and settling would
// hang.
const waitForPageShell = () => waitFor(() => expect(
  screen.queryByRole('status', { name: 'Loading Chief of Staff' }),
).toBeNull());

const renderSettledAt = async (tab) => {
  const result = renderPageAt(tab);
  await waitForPageShell();
  return result;
};

const renderSettledConfigTab = async () => {
  // The page shell settles before this lazy tab's import. Resolve that import
  // outside DOM-query deadlines so contended transforms cannot time out the
  // Force Evaluate tests before their action even exists.
  await act(async () => { await import('../components/cos/tabs/ConfigTab'); });
  // #11548 — warming the module does not initialize React.lazy's thenable.
  // Mount inside async act as well, so the resolved lazy retry commits before
  // the caller starts its control query. The shell alone can still show the
  // configuration Suspense fallback even after the module import has resolved.
  let result;
  await act(async () => { result = renderPageAt('config'); });
  await waitForPageShell();
  return result;
};

function installChiefOfStaffHooks() {
  beforeEach(() => {
    vi.clearAllMocks();
    socketStub.resetListeners();
    api.getCosStatus.mockResolvedValue({ running: false, config, stats: {} });
    api.getInstanceFeatures.mockResolvedValue({ features: [] });
    api.getCosTasks.mockResolvedValue({ user: null, cos: null });
    api.getCosAgents.mockResolvedValue([]);
    api.getCosHealth.mockResolvedValue({ issues: [] });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getApps.mockResolvedValue([]);
    api.getCosSchedule.mockResolvedValue({ tasks: {} });
    api.getCosLearningSummary.mockResolvedValue(null);
    api.getCosActionableInsights.mockResolvedValue({ insights: [] });
    api.forceHealthCheck.mockResolvedValue({ metrics: { timestamp: 1 }, issues: [] });
    api.updateCosTask.mockResolvedValue({ id: 'task-updated', status: 'pending', metadata: {} });
    api.getCosTodayActivity.mockResolvedValue({ isRunning: false, stats: { completed: 0 } });
    api.getCosLearning.mockResolvedValue(null);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getCosBudgetUsage.mockResolvedValue({ usage: {} });
    api.getPersistentMind.mockResolvedValue({
      state: { enabled: false, started: false, status: 'disabled', queuedMessageCount: 0 },
      profile: { enabled: false, providerId: null, model: null },
    });
    api.pauseCos.mockResolvedValue({ success: true, pausedAt: '2026-01-01T00:00:00.000Z' });
    api.resumeCos.mockResolvedValue({ success: true });
    api.getCosLearningDurations.mockResolvedValue(null);
    api.getCosPopularTemplates.mockResolvedValue([]);
    api.getCodeReviewDefaults.mockResolvedValue({});
    api.getRiggedAvatars.mockResolvedValue({ records: [] });
    api.getCosCompletedAgents.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    api.getCosPendingAgentFeedback.mockResolvedValue({ agents: [], count: null });
    localLlm.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    localLlm.getToolUseModels.mockResolvedValue({ models: [] });
  });

  // Tests that drain a debounce or the avatar's speaking timer install fake timers
  // (see `withFakeTimers` below); this restores real ones for everyone else.
  afterEach(() => vi.useRealTimers());
}

export {
  api,
  toast,
  socketStub,
  ChiefOfStaff,
  config,
  withFakeTimers,
  renderPageAt,
  waitForPageShell,
  renderSettledAt,
  renderSettledConfigTab,
  installChiefOfStaffHooks,
};
