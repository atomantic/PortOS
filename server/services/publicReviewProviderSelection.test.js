import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAllProviders = vi.fn();
const isProviderAvailable = vi.fn(() => true);

vi.mock('./providers.js', () => ({ getAllProviders }));
vi.mock('./providerStatus.js', () => ({ isProviderAvailable }));

const {
  eligiblePublicReviewProviders,
  publicReviewPostureForTask,
  resolvePublicReviewProvider,
} = await import('./publicReviewProviderSelection.js');

const CODEX = { id: 'codex-cli', type: 'cli', command: 'codex' };
const GROK = { id: 'grok-cli', type: 'cli', command: 'grok' };
const LOCAL_CLAUDE = { id: 'claude-ollama', type: 'cli', command: 'claude', ollamaBacked: true };
const OPENCODE = { id: 'opencode', type: 'cli', command: 'opencode' };
const OLLAMA_API = { id: 'ollama', type: 'api' };

const seed = (providers, activeProvider = null) => {
  getAllProviders.mockResolvedValue({ providers, activeProvider });
};

describe('publicReviewPostureForTask', () => {
  it('maps a stage execution profile to its posture and ignores ordinary tasks', () => {
    expect(publicReviewPostureForTask({ metadata: { executionProfile: 'public-review-gate' } })).toBe('no-tool');
    expect(publicReviewPostureForTask({ metadata: { executionProfile: 'public-review-actions' } })).toBe('sandboxed-actions');
    expect(publicReviewPostureForTask({ metadata: {} })).toBeNull();
    expect(publicReviewPostureForTask(undefined)).toBeNull();
  });
});

describe('eligiblePublicReviewProviders', () => {
  beforeEach(() => vi.clearAllMocks());

  // The regression this uniquely catches: an install without codex/antigravity
  // must still surface its own providers rather than an empty list.
  it('returns this install’s own eligible providers, not a fixed vendor list', async () => {
    seed([GROK, OPENCODE, OLLAMA_API]);
    expect((await eligiblePublicReviewProviders('no-tool')).map((p) => p.id)).toEqual(['grok-cli']);
    // The actions stage is open to every binary provider — opencode has no
    // sandbox recipe but runs headless in the disposable worktree; the api
    // provider has no binary at all.
    expect((await eligiblePublicReviewProviders('sandboxed-actions')).map((p) => p.id)).toEqual(['grok-cli', 'opencode']);
  });

  it('excludes providers the user has switched off', async () => {
    seed([{ ...CODEX, enabled: false }, LOCAL_CLAUDE]);
    expect((await eligiblePublicReviewProviders('no-tool')).map((p) => p.id)).toEqual(['claude-ollama']);
  });

  it('keeps a momentarily-unavailable provider selectable', async () => {
    isProviderAvailable.mockReturnValue(false);
    seed([CODEX]);
    expect((await eligiblePublicReviewProviders('no-tool')).map((p) => p.id)).toEqual(['codex-cli']);
  });
});

describe('resolvePublicReviewProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isProviderAvailable.mockReturnValue(true);
  });

  it('honors an eligible stage pin over the active provider', async () => {
    seed([CODEX, GROK], { id: 'codex-cli' });
    await expect(resolvePublicReviewProvider({ posture: 'no-tool', pinnedProviderId: 'grok-cli' }))
      .resolves.toMatchObject({ ok: true, pinHonored: true, provider: { id: 'grok-cli' } });
  });

  it('drops an INELIGIBLE pin instead of running the stage on it', async () => {
    seed([OPENCODE, CODEX], { id: 'opencode' });
    const resolved = await resolvePublicReviewProvider({ posture: 'no-tool', pinnedProviderId: 'opencode' });
    expect(resolved).toMatchObject({ ok: true, pinHonored: false, provider: { id: 'codex-cli' } });
  });

  it('honors any enabled binary provider as an actions-stage pin', async () => {
    seed([OPENCODE, CODEX], { id: 'codex-cli' });
    const resolved = await resolvePublicReviewProvider({ posture: 'sandboxed-actions', pinnedProviderId: 'opencode' });
    expect(resolved).toMatchObject({ ok: true, pinHonored: true, provider: { id: 'opencode' } });
  });

  it('prefers an available provider over an unavailable earlier one', async () => {
    isProviderAvailable.mockImplementation((id) => id === 'grok-cli');
    seed([CODEX, GROK]);
    await expect(resolvePublicReviewProvider({ posture: 'no-tool' }))
      .resolves.toMatchObject({ provider: { id: 'grok-cli' } });
  });

  it('still resolves when every eligible provider is momentarily unavailable', async () => {
    isProviderAvailable.mockReturnValue(false);
    seed([CODEX]);
    await expect(resolvePublicReviewProvider({ posture: 'no-tool' }))
      .resolves.toMatchObject({ ok: true, provider: { id: 'codex-cli' } });
  });

  it('fails closed with an actionable reason when nothing on this install qualifies', async () => {
    seed([OPENCODE, OLLAMA_API]);
    const gate = await resolvePublicReviewProvider({ posture: 'no-tool' });
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe('public-review-no-eligible-provider');
    expect(gate.error).toMatch(/no-tool/);

    seed([OLLAMA_API, { ...OPENCODE, enabled: false }]);
    const actions = await resolvePublicReviewProvider({ posture: 'sandboxed-actions' });
    expect(actions.ok).toBe(false);
    expect(actions.code).toBe('public-review-no-eligible-provider');
    expect(actions.error).toMatch(/sandboxed-actions/);
  });
});
