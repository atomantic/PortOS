/**
 * Shared fixture payloads for the `OpenWorld` PAGE suites (transport, fast
 * travel, and whatever comes next). Each of those suites stubs the same 3D
 * scene, the same data hook, and the same nine API endpoints purely to get the
 * page mountable in jsdom — none of it is what any of them is testing, and a
 * new endpoint the page starts polling otherwise has to be added to every copy.
 *
 * The `vi.mock` CALLS must stay in each test file: vitest hoists them above the
 * imports, so a factory defined here can only be reached by `await import`ing
 * this module INSIDE the factory —
 *
 *   vi.mock('../hooks/useOpenWorldData', async () => ({
 *     useOpenWorldData: () => (await import('../test/openWorldPageMocks.js')).OPEN_WORLD_DATA,
 *   }));
 *
 * — which is why these are plain exported values rather than a helper that
 * registers the mocks for you.
 *
 * Anything a suite ASSERTS on stays in that suite: the scene/HUD stubs that
 * record props, the playback spies, the per-test payload overrides.
 */

/**
 * The `useOpenWorldData` return shape, with every field empty. A suite that
 * needs one field populated spreads this and overrides that field.
 */
export const OPEN_WORLD_DATA = {
  apps: [],
  cosAgents: [],
  cosStatus: {},
  eventLogs: [],
  agentMap: new Map(),
  reviewCounts: {},
  instances: {},
  systemHealth: null,
  notificationCounts: {},
  backupStatus: null,
  cosTasks: [],
  healthMetrics: null,
  voiceState: null,
  character: null,
  aiActivity: null,
  loading: false,
  connected: true,
};

/**
 * Build the `services/api` stub — only the endpoints the page polls. The real
 * module pulls in the socket client, which has no place in a jsdom page test;
 * `useAutoRefetch` is stubbed alongside it, so none of these actually fire.
 *
 * Takes `vi` as an argument because a `vi.mock` factory runs before this
 * module's own imports would resolve.
 *
 * @param {typeof import('vitest').vi} vi
 */
export function openWorldApiMock(vi) {
  return {
    getInstanceFeatures: vi.fn(async () => ({ features: [] })),
    getCosQuickSummary: vi.fn(async () => null),
    getCosActivityCalendar: vi.fn(async () => null),
    getGoals: vi.fn(async () => null),
    getChronotype: vi.fn(async () => null),
    getMemoryGraph: vi.fn(async () => null),
    getBrainInbox: vi.fn(async () => null),
    getOpenWorldIntrospection: vi.fn(async () => null),
    getMySprintTickets: vi.fn(async () => []),
  };
}

/**
 * The `useOpenWorldPlayback` return shape with playback INACTIVE — what a suite
 * that isn't testing the transport wants. Spies are built per call so two
 * suites never share call history.
 *
 * @param {typeof import('vitest').vi} vi
 */
export function openWorldPlaybackMock(vi) {
  return {
    active: false,
    currentFrame: null,
    snapshots: [],
    frameIndex: 0,
    stats: null,
    playing: false,
    speed: 1,
    loading: false,
    error: null,
    enter: vi.fn(),
    exit: vi.fn(),
    seek: vi.fn(),
    step: vi.fn(),
    togglePlay: vi.fn(),
    cycleSpeed: vi.fn(),
  };
}
