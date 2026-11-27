import { beforeEach, afterEach, vi } from 'vitest';
import { readJSONFile } from '../lib/fileUtils.js'
import { writeFile } from 'fs/promises'
import { parseCronToNextRun } from './eventScheduler.js'
import { isInstanceFeatureEnabled } from './instanceFeatures.js'

vi.mock('./cos/cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn()
}))

// fileUtils mock: include every named export consumed by ./cos/cosState.js too,
// so vi.importActual('./cos/cosState.js') below resolves cleanly.
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn().mockResolvedValue(),
  ensureDirs: vi.fn().mockResolvedValue(),
  readJSONFile: vi.fn(),
  safeJSONParse: (content, fallback) => { try { return JSON.parse(content); } catch { return fallback; } },
  // atomicWrite replaced the raw writeFile(JSON.stringify) schedule-save site (#1837);
  // route it through the mocked fs/promises.writeFile so the tests that read
  // writeFile.mock.calls.at(-1)[1] still observe the persisted schedule JSON.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
  PATHS: { cos: '/mock/data/cos', root: '/mock', reports: '/mock/reports', scripts: '/mock/scripts' },
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  safeDate: (d) => d ? new Date(d).getTime() : 0
}))

// slashdoLoader mock: taskPromptService.js reads the bundled command body
// through loadSlashdoFile — stub it the same way the prior fileUtils mock did,
// now that the slashdo loaders live in their own module (#3110's home moved).
// Operator-action ledger (#5594). Stubbed so the origin gate in
// triggerOnDemandTask can be asserted directly (recorded vs not recorded)
// without this suite's minimal fileUtils stub having to grow a data root.
vi.mock('./userActions.js', () => ({ recordUserAction: vi.fn() }));

vi.mock('../lib/slashdoLoader.js', () => ({
  loadSlashdoFile: vi.fn().mockResolvedValue(''),
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(),
  readFile: vi.fn().mockRejectedValue(new Error('readFile not mocked')),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}))

vi.mock('./apps.js', () => ({
  isTaskTypeEnabledForApp: vi.fn().mockResolvedValue(true),
  getAppTaskTypeInterval: vi.fn().mockResolvedValue(null),
  getAppTaskTypeIntervalMs: vi.fn().mockResolvedValue(null),
  getActiveApps: vi.fn().mockResolvedValue([]),
  getAppById: vi.fn().mockResolvedValue(null),
  getAppTaskTypeOverrides: vi.fn().mockResolvedValue({}),
  clearAllPrWatcherState: vi.fn().mockResolvedValue({ changed: false }),
  clearAllIssueWatcherState: vi.fn().mockResolvedValue({ changed: false })
}))

vi.mock('./taskInputGate.js', () => ({ inputsUnchangedSince: vi.fn().mockResolvedValue(false), readHead: vi.fn() }))

vi.mock('./branchReconcileInventoryPrune.js', async importOriginal => ({ ...await importOriginal(), reconcileInventoryRows: vi.fn(async (_repo, rows) => rows) }))

vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn().mockResolvedValue(true),
}))

vi.mock('../lib/portosUrls.js', () => ({
  PORTOS_UI_URL: 'http://localhost:5554',
  PORTOS_API_URL: 'http://localhost:5555'
}))

vi.mock('../lib/timezone.js', () => ({
  getLocalParts: vi.fn(() => ({ dayOfWeek: 3 })),
}))

vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
}))

vi.mock('./eventScheduler.js', () => ({
  parseCronToNextRun: vi.fn()
}))

// Failure-park auto-notification (#2616): recordTaskTypeFailure lazy-imports
// notifications.js and fires an AGENT_WARNING when a type auto-parks. Mock it so
// the ledger tests can assert the notification without touching the real store.
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  removeByMetadata: vi.fn().mockResolvedValue({ success: true, removedIds: [] }),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' }
}))

// Use the real isImprovementEnabled implementation; only stub loadState.
// Mocking the helper would let regressions in production logic slip through.
vi.mock('./cos/cosState.js', async () => {
  const actual = await vi.importActual('./cos/cosState.js')
  return {
    ...actual,
    loadState: vi.fn().mockResolvedValue({ config: { improvementEnabled: true } })
  }
})

const mockSchedule = ({ tasks = {}, executions = {}, templates = [], onDemandRequests = [] } = {}) => {
  readJSONFile.mockResolvedValue({ version: 2, tasks, executions, templates, onDemandRequests })
}

// loadSchedule merges DEFAULT_TASK_INTERVALS over whatever a fixture supplies,
// and the shipped reconcile drains are enabled + perpetual — so they are due on
// every tick. A case asserting on "which tasks are due" has to pause them
// explicitly or its expectation reads them as noise.
const PAUSED_SHIPPED_DRAINS = {
  'branch-reconcile': { enabled: false },
  'issue-reconcile': { enabled: false },
}

// The cron parser is mocked module-wide, so a case that wants a cron task
// simply due (or simply on cooldown) states it here rather than hand-picking
// wall-clock instants: a slot in the current minute, or one still ahead.
const cronDueNow = () => {
  parseCronToNextRun.mockReturnValue(new Date(Math.floor(Date.now() / 60_000) * 60_000))
}

const cronNotDueYet = () => {
  parseCronToNextRun.mockReturnValue(new Date(Date.now() + 60 * 60 * 1000))
}

function installScheduleHooks() {
  beforeEach(() => {
    vi.clearAllMocks()
    isInstanceFeatureEnabled.mockResolvedValue(true)
    // Default: no saved schedule → use defaults
    readJSONFile.mockResolvedValue(null)
    writeFile.mockResolvedValue(undefined)
  })

  // Cases that freeze the clock restore it here, so a failed assertion inside a
  // faked-timer block can't leak fake time into every case that follows.
  afterEach(() => {
    vi.useRealTimers()
  })
}

export {
  mockSchedule,
  PAUSED_SHIPPED_DRAINS,
  cronDueNow,
  cronNotDueYet,
  installScheduleHooks,
};
