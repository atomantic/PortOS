
import { vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import AIProviders from './AIProviders';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getProviderStatuses: vi.fn(),
  getProviderRuntimes: vi.fn(),
  getProviderReadiness: vi.fn(),
  // Kept pending by default so existing page tests that use a Codex fixture do
  // not accidentally assert a subscription account state. Subscription-specific
  // tests replace this with a bounded readiness response.
  getCodexAccount: vi.fn(() => new Promise(() => {})),
  getCodexModels: vi.fn(),
  startCodexLogin: vi.fn(),
  cancelCodexLogin: vi.fn(),
  codexLogout: vi.fn(),
  getInstances: vi.fn(),
  getSampleProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  refreshProviderModels: vi.fn(),
  // The retired-model-pin panel reads on mount. Resolved empty so a healthy
  // install renders nothing extra — the panel has its own suite.
  getModelPinWarnings: vi.fn().mockResolvedValue({ pins: [], providers: {} }),
  clearModelPin: vi.fn(),
  setActiveProvider: vi.fn().mockResolvedValue({}),
  createRun: vi.fn().mockResolvedValue({ runId: 'run-1' }),
  stopRun: vi.fn().mockResolvedValue({}),
  // The compatibility matrix reads the composition catalog (#7567). Empty by
  // default so the preset list renders exactly as before; the matrix has its
  // own cases below.
  getProviderCatalog: vi.fn().mockResolvedValue({
    harnesses: [], services: [], bootstraps: [], compatibility: {}, effortLevels: {}, effortLevelsByModel: {}, presets: [],
  }),
  getProviderBootstraps: vi.fn().mockResolvedValue({ bootstraps: {} }),
  getHarnesses: vi.fn().mockResolvedValue({ harnesses: [] }),
  createProviderPreset: vi.fn(),
  // The Services view lists instances; empty by default.
  getProviderServices: vi.fn().mockResolvedValue({ services: [] }),
}));

const localModels = vi.hoisted(() => ({ value: { ctxById: {}, installed: { ollama: null, lmstudio: null } } }));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../services/apiCore.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, request: (url, options) => url.includes('/execution-options') ? Promise.resolve({ options: [] }) : actual.request(url, options) };
});

vi.mock('../services/apiLocalLlm.js', async (importOriginal) => ({
  ...await importOriginal(),
  getLocalPersistentMindSetup: vi.fn(async () => null),
  // The Generation tab's context planner reads on mount; it has its own suite.
  getContextPlans: vi.fn(async () => ({ budgetBytes: null, plans: [] })),
}));

vi.mock('../services/apiApps.js', () => ({ getApps: api.getApps }));

// The Mixture of Agents section mounts on the presets view; it has its own suite.
vi.mock('../services/apiMoaPresets', () => ({
  listMoaPresets: vi.fn(async () => ({ presets: [], maxReferenceModels: 5, instructions: null })),
  createMoaPreset: vi.fn(), updateMoaPreset: vi.fn(), deleteMoaPreset: vi.fn(),
}));

vi.mock('../services/apiSystem.js', () => ({ getInstances: api.getInstances }));

vi.mock('../services/apiRuns.js', () => ({ createRun: api.createRun, stopRun: api.stopRun }));

vi.mock('../services/apiHarnesses.js', () => ({ getHarnesses: api.getHarnesses }));

vi.mock('../services/apiProviders', () => ({
  getFleetLlmHost: vi.fn(() => new Promise(() => {})),
  getFleetPeerHosts: vi.fn(() => new Promise(() => {})),
  revealFleetLlmHostKey: vi.fn(),
  revealFleetPeerHostKey: vi.fn(),
  getProviders: api.getProviders,
  getProviderStatuses: api.getProviderStatuses,
  getProviderRuntimes: api.getProviderRuntimes,
  getProviderReadiness: api.getProviderReadiness,
  getCodexAccount: api.getCodexAccount,
  getCodexModels: api.getCodexModels,
  startCodexLogin: api.startCodexLogin,
  cancelCodexLogin: api.cancelCodexLogin,
  codexLogout: api.codexLogout,
  getSampleProviders: api.getSampleProviders,
  createProvider: api.createProvider,
  updateProvider: api.updateProvider,
  refreshProviderModels: api.refreshProviderModels,
  getModelPinWarnings: api.getModelPinWarnings,
  clearModelPin: api.clearModelPin,
  setActiveProvider: api.setActiveProvider,
  getProviderCatalog: api.getProviderCatalog,
  getProviderBootstraps: api.getProviderBootstraps,
  createProviderPreset: api.createProviderPreset,
  getProviderServices: api.getProviderServices,
}));

vi.mock('../components/ui/Toast', () => ({
  default: toast,
}));

vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock('../hooks/useLocalModels', () => ({
  default: () => localModels.value,
}));

vi.mock('../components/models/ModelsTabsHeader', async (importOriginal) => ({
  // The real strip: it is the page's only tab row, so tests drive navigation through it.
  ...(await importOriginal()),
  ModelsSectionLayout: ({ children }) => <>{children}</>,
}));

vi.mock('../components/install/RuntimeInstallModal', () => ({
  // `params` becomes the setup request's query string, so the test can assert
  // WHICH setup step the clicked button asked for.
  default: ({ open, runtime, streamMethod, flushMs, params }) => open
    ? <div data-testid="runtime-install-modal" data-runtime={runtime} data-stream-method={streamMethod} data-flush-ms={flushMs} data-params={JSON.stringify(params || {})} />
    : null,
}));

// The editor is route-driven (/ai/presets/new · /ai/presets/:presetId over
// the same page, plus the legacy /ai/edit/:providerId alias), so the tests
// mount the real route table rather than a bare page — clicking Edit
// navigates, and a deep link can be rendered directly. The three views are
// route prefixes of the same page (#7567).
function ShellLocation() {
  const { pathname, search } = useLocation();
  return <div data-testid="shell-location">{`${pathname}${search}`}</div>;
}

const mountPage = (initialPath = '/ai/presets') => render(
  <MemoryRouter initialEntries={[initialPath]}>
    <Routes>
      <Route path="/ai/presets" element={<AIProviders />} />
      <Route path="/ai/presets/new" element={<AIProviders />} />
      <Route path="/ai/presets/:presetId" element={<AIProviders />} />
      <Route path="/ai/edit/:providerId" element={<AIProviders />} />
      <Route path="/ai/fleet" element={<AIProviders />} />
      <Route path="/ai/harnesses" element={<AIProviders />} />
      <Route path="/ai/harnesses/:harnessId" element={<AIProviders />} />
      <Route path="/ai/services" element={<AIProviders />} />
      <Route path="/ai/services/new" element={<AIProviders />} />
      <Route path="/ai/services/:serviceSlug" element={<AIProviders />} />
      <Route path="/shell" element={<ShellLocation />} />
    </Routes>
  </MemoryRouter>
);

const renderPage = async (initialPath) => {
  const result = mountPage(initialPath);
  await act(async () => {});
  return result;
};

// The editor opens on the Connection tab; every other field lives behind a tab
// switch (the drawer renders only the active panel).
const openEditorTab = async (label) => {
  fireEvent.click(await screen.findByRole('tab', { name: label }));
  // Settle tab-mount reads (the Generation tab's context planner) inside act.
  await act(async () => {});
};

// The rare page actions (Compare local models, Fleet setup, Load Samples) sit
// behind the header's overflow menu since #5653, so the bar stays one row tall.
const openHeaderMenu = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'More provider actions' }));
};

const clickLoadSamples = async () => {
  await openHeaderMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Load Samples' }));
};

// One entry of the `runtimes` map from GET /api/providers/runtimes.
const missingRuntime = {
  id: 'opencode',
  label: 'OpenCode CLI',
  command: 'opencode',
  installed: false,
  method: 'npm',
  installable: true,
  blockedReason: null,
  docsUrl: 'https://opencode.ai/docs',
};

export {
  api,
  localModels,
  toast,
  mountPage,
  renderPage,
  openEditorTab,
  openHeaderMenu,
  clickLoadSamples,
  missingRuntime,
};
