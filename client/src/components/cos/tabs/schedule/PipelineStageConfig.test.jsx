import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// The installed-local-model report, mutable so a test can model a daemon that
// is stopped or still loading (both of which `useLocalModels` reports as `[]`).
const INSTALLED_LOCAL_MODELS = {
  ollama: ['safe-model', 'tool-model'],
  lmstudio: [],
  capabilitiesByBackend: {
    ollama: {
      'safe-model': ['chat'],
      'tool-model': ['chat', 'tools'],
    },
  },
  loading: false,
};
let localModels = { ...INSTALLED_LOCAL_MODELS };

vi.mock('../../../../hooks/useLocalModels', () => ({
  default: () => localModels,
}));

beforeEach(() => {
  localModels = { ...INSTALLED_LOCAL_MODELS };
});

import PipelineStageConfig from './PipelineStageConfig';

const STAGES = [
  {
    name: 'Security Scan',
    role: 'security',
    promptKey: 'pr-reviewer-security',
    readOnly: true,
  },
  {
    name: 'Eligibility Gate',
    role: 'eligibility',
    promptKey: 'pr-reviewer-eligibility',
    readOnly: true,
    providerId: 'claude-ollama',
    model: 'safe-model',
  },
  {
    name: 'Code Review & Actions',
    role: 'actions',
    promptKey: 'pr-reviewer-review',
    readOnly: true,
    providerId: 'codex-cli',
    model: 'gpt-5.6',
  },
];

const providers = [
  {
    id: 'claude-ollama',
    name: 'Local Claude',
    type: 'cli',
    command: 'claude',
    endpoint: 'http://127.0.0.1:11434',
    publicReviewSupported: true,
    models: ['safe-model'],
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    type: 'cli',
    command: 'codex',
    publicReviewActionsSupported: true,
    models: ['gpt-5.6'],
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    type: 'cli',
    command: 'agy',
    publicReviewActionsSupported: true,
    models: ['gemini-3.6-flash'],
  },
  {
    id: 'other-cli',
    name: 'Other CLI',
    type: 'cli',
    command: 'other-agent',
    models: ['other-model'],
  },
];

function renderStages(stages = STAGES, onUpdate = vi.fn().mockResolvedValue(undefined)) {
  render(
    <MemoryRouter>
      <PipelineStageConfig
        taskType="pr-reviewer"
        config={{ taskMetadata: { pipeline: { stages } } }}
        providers={providers}
        onUpdate={onUpdate}
        updating={false}
        setUpdating={() => {}}
      />
    </MemoryRouter>,
  );
  return onUpdate;
}

describe('PipelineStageConfig — pr-reviewer', () => {
  it('uses shared capability policies for the gate and sandbox-capable action providers', () => {
    renderStages();

    const providerSelects = screen.getAllByLabelText('Provider');
    expect([...providerSelects[0].options].map((option) => option.value)).toEqual(['', 'claude-ollama']);
    expect([...providerSelects[1].options].map((option) => option.value)).toEqual(['', 'codex-cli', 'antigravity-cli']);

    const modelSelects = screen.getAllByLabelText('Model');
    expect([...modelSelects[0].options].map((option) => option.value)).toEqual(['', 'safe-model']);
    expect([...modelSelects[1].options].map((option) => option.value)).toEqual(['', 'gpt-5.6']);
    expect(screen.getByText(/maintained OS sandbox/i)).toBeInTheDocument();
  });

  it('removes the optional actions stage without changing the mandatory gate', async () => {
    const onUpdate = renderStages();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable final code review and actions' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('pr-reviewer', {
      taskMetadata: {
        pipeline: { stages: STAGES.slice(0, 2) },
      },
    }));
  });

  it('restores the complete restricted action-stage posture when enabled', async () => {
    const onUpdate = renderStages(STAGES.slice(0, 2));
    fireEvent.click(screen.getByRole('switch', { name: 'Enable final code review and actions' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('pr-reviewer', {
      taskMetadata: expect.objectContaining({
        pipeline: expect.objectContaining({
          stages: expect.arrayContaining([
            expect.objectContaining({
              role: 'actions',
              promptKey: 'pr-reviewer-review',
              executionProfile: 'public-review-actions',
              discardWorktree: true,
              noCodeOutput: true,
            }),
          ]),
        }),
      }),
    }));
  });
});

// The refactor's core promise: the picker's eligible set comes from the
// server-published `publicReviewPostures` on each provider, so an install with
// none of the vendors the old copy named still configures both stages.
describe('PipelineStageConfig — posture-driven eligibility', () => {
  const profiledStages = [
    STAGES[0],
    { ...STAGES[1], executionProfile: 'public-review-gate', providerId: '', model: '' },
    { ...STAGES[2], executionProfile: 'public-review-actions', providerId: '', model: '' },
  ];

  const renderWith = (installProviders) => render(
    <MemoryRouter>
      <PipelineStageConfig
        taskType="pr-reviewer"
        config={{ taskMetadata: { pipeline: { stages: profiledStages } } }}
        providers={installProviders}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        updating={false}
        setUpdating={() => {}}
      />
    </MemoryRouter>,
  );

  it('offers a grok-only install its own provider for BOTH stages', () => {
    renderWith([
      { id: 'grok-cli', name: 'Grok', type: 'cli', command: 'grok', models: ['grok-4'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
      { id: 'opencode', name: 'OpenCode', type: 'cli', command: 'opencode', models: ['x'], publicReviewPostures: [] },
    ]);
    const providerSelects = screen.getAllByLabelText('Provider');
    expect([...providerSelects[0].options].map((o) => o.value)).toEqual(['', 'grok-cli']);
    expect([...providerSelects[1].options].map((o) => o.value)).toEqual(['', 'grok-cli']);
    // A non-local provider's own catalog is selectable — the installed-local
    // model list only applies where PortOS can probe capabilities.
    expect(screen.getByText(/^Tool-free stage\./)).toBeInTheDocument();
    expect(screen.getByText(/^Sandboxed stage\./)).toBeInTheDocument();
  });

  // The bug behind #5906's blocked run: the CLI records were disabled and the
  // TUI records enabled, so the note listed three "eligible" providers while
  // the dropdown offered only the placeholder. Eligibility now follows what the
  // server publishes for the ENABLED records — TUI siblings included — and the
  // dropdown is the only place that list is rendered.
  it('offers only enabled providers in the dropdown, and names none of them in the note', () => {
    renderWith([
      { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', enabled: false, models: ['gpt-5.6'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
      { id: 'codex-tui', name: 'Codex TUI', type: 'tui', command: 'codex', enabled: true, models: ['gpt-5.6'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
      { id: 'grok-cli', name: 'Grok Build CLI', type: 'cli', command: 'grok', enabled: false, models: ['grok-4'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
    ]);
    const providerSelects = screen.getAllByLabelText('Provider');
    expect([...providerSelects[1].options].map((o) => o.value)).toEqual(['', 'codex-tui']);
    // The dropdown IS the eligible list; the note must not re-name providers,
    // least of all the disabled ones.
    const note = screen.getByText(/^Sandboxed stage\./);
    expect(note.textContent).not.toContain('Grok Build CLI');
    expect(note.textContent).not.toContain('Codex CLI');
  });

  it('warns instead of silently offering nothing when a stage has no eligible provider', () => {
    renderWith([
      { id: 'claude-ollama', name: 'Local Claude', type: 'cli', command: 'claude', endpoint: 'http://127.0.0.1:11434', models: ['safe-model'], publicReviewPostures: ['no-tool'] },
    ]);
    expect(screen.getByText(/No enabled AI provider on this install can enforce the sandboxed-actions posture/)).toBeInTheDocument();
  });

  // Stage 3 offers every enabled binary provider the server publishes as
  // runnable, and the note separates the vendor-sandboxed ones from those the
  // disposable worktree alone isolates.
  it('offers a worktree-only provider for the actions stage and says which providers are OS-sandboxed', () => {
    renderWith([
      { id: 'codex-tui', name: 'Codex TUI', type: 'tui', command: 'codex', models: ['gpt-5.6'], publicReviewPostures: ['no-tool', 'sandboxed-actions'], publicReviewEnforcedPostures: ['no-tool', 'sandboxed-actions'] },
      { id: 'opencode-tui', name: 'OpenCode TUI', type: 'tui', command: 'opencode', models: ['x'], publicReviewPostures: ['sandboxed-actions'], publicReviewEnforcedPostures: [] },
    ]);
    const providerSelects = screen.getAllByLabelText('Provider');
    expect([...providerSelects[0].options].map((o) => o.value)).toEqual(['', 'codex-tui']);
    expect([...providerSelects[1].options].map((o) => o.value)).toEqual(['', 'codex-tui', 'opencode-tui']);
    const note = screen.getByText(/^Sandboxed stage\./);
    // The eligible set is the dropdown's job; the note only separates the
    // vendor-sandboxed providers from the worktree-only ones.
    expect(note.textContent).not.toContain('Eligible on this install');
    expect(note.textContent).toContain("OS-sandboxed by the vendor's own recipe: Codex TUI.");
    expect(note.textContent).toContain('isolated by the disposable worktree only: OpenCode TUI.');
  });

  // A local runtime's daemon is the authority on what it serves; the provider
  // record's `models` array is a cached snapshot. The tool-free gate already
  // read the daemon, but the sandboxed actions stage read the snapshot — so a
  // stage on a local provider could only be pinned to models that had since
  // been removed, and never to one just pulled.
  it('offers the installed local models for a local-backed ACTIONS stage', () => {
    const localProvider = {
      id: 'opencode-ollama-tui',
      name: 'OpenCode Ollama TUI',
      type: 'tui',
      command: 'opencode',
      models: ['stale-cached-model'],
      publicReviewPostures: ['no-tool', 'sandboxed-actions'],
      publicReviewEnforcedPostures: ['no-tool'],
    };
    render(
      <MemoryRouter>
        <PipelineStageConfig
          taskType="pr-reviewer"
          config={{ taskMetadata: { pipeline: { stages: [
            profiledStages[0],
            profiledStages[1],
            { ...profiledStages[2], providerId: 'opencode-ollama-tui', model: 'tool-model' },
          ] } } }}
          providers={[localProvider]}
          onUpdate={vi.fn().mockResolvedValue(undefined)}
          updating={false}
          setUpdating={() => {}}
        />
      </MemoryRouter>,
    );

    const modelSelects = screen.getAllByLabelText('Model');
    // The daemon's installed models, NOT the record's `stale-cached-model`.
    expect([...modelSelects[1].options].map((o) => o.value)).toEqual(['', 'safe-model', 'tool-model']);
  });
});

// `useLocalModels` reports "not fetched yet" and "the daemon listed nothing"
// identically, as `[]` — so an empty list is not evidence the daemon serves no
// models. The actions stage has no capability gate, so it must fall back to the
// record's catalog rather than render an empty picker that also drops the
// stage's own saved pin. The tool-free gate deliberately does NOT: a model with
// no probeable capability report is not selectable there at all.
describe('PipelineStageConfig — local daemon unreachable', () => {
  const LOCAL = {
    id: 'opencode-ollama-tui',
    name: 'OpenCode Ollama TUI',
    type: 'tui',
    command: 'opencode',
    models: ['cached-a', 'cached-b'],
    publicReviewPostures: ['no-tool', 'sandboxed-actions'],
    publicReviewEnforcedPostures: ['no-tool'],
  };

  it('falls back to the record catalog for the actions stage, but not for the gate', () => {
    localModels = { ollama: [], lmstudio: [], capabilitiesByBackend: {}, loading: false };
    render(
      <MemoryRouter>
        <PipelineStageConfig
          taskType="pr-reviewer"
          config={{ taskMetadata: { pipeline: { stages: [
            STAGES[0],
            { ...STAGES[1], executionProfile: 'public-review-gate', providerId: 'opencode-ollama-tui', model: 'cached-a' },
            { ...STAGES[2], executionProfile: 'public-review-actions', providerId: 'opencode-ollama-tui', model: 'cached-a' },
          ] } } }}
          providers={[LOCAL]}
          onUpdate={vi.fn().mockResolvedValue(undefined)}
          updating={false}
          setUpdating={() => {}}
        />
      </MemoryRouter>,
    );
    const modelSelects = screen.getAllByLabelText('Model');
    // The gate offers nothing from the catalog — `cached-a` is present only
    // because ProviderModelSelector keeps a disallowed *selected* value visible
    // rather than blanking the control, and `cached-b` proves the list itself
    // was not consulted.
    expect([...modelSelects[0].options].map((o) => o.value)).toEqual(['', 'cached-a']);
    // The actions stage gets the whole record catalog instead of an empty
    // picker that would also drop its own saved pin (nothing re-adds it there:
    // its policy allows every model, so the disallowed affordance never fires).
    expect([...modelSelects[1].options].map((o) => o.value)).toEqual(['', 'cached-a', 'cached-b']);
  });
});
