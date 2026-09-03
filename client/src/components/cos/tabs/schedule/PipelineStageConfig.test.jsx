import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../../hooks/useLocalModels', () => ({
  default: () => ({
    ollama: ['safe-model', 'tool-model'],
    lmstudio: [],
    capabilitiesByBackend: {
      ollama: {
        'safe-model': ['chat'],
        'tool-model': ['chat', 'tools'],
      },
    },
    loading: false,
  }),
}));

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
    expect(screen.getAllByText(/Eligible on this install: Grok/).length).toBe(2);
  });

  // The bug behind #5906's blocked run: the CLI records were disabled and the
  // TUI records enabled, so the note listed three "eligible" providers while
  // the dropdown offered only the placeholder. Eligibility now follows what the
  // server publishes for the ENABLED records — TUI siblings included.
  it('lists only enabled providers as eligible, matching what the dropdown offers', () => {
    renderWith([
      { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', enabled: false, models: ['gpt-5.6'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
      { id: 'codex-tui', name: 'Codex TUI', type: 'tui', command: 'codex', enabled: true, models: ['gpt-5.6'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
      { id: 'grok-cli', name: 'Grok Build CLI', type: 'cli', command: 'grok', enabled: false, models: ['grok-4'], publicReviewPostures: ['no-tool', 'sandboxed-actions'] },
    ]);
    const providerSelects = screen.getAllByLabelText('Provider');
    expect([...providerSelects[1].options].map((o) => o.value)).toEqual(['', 'codex-tui']);
    const note = screen.getByText(/Sandboxed stage\. Eligible on this install:/);
    expect(note.textContent).toContain('Eligible on this install: Codex TUI.');
    expect(note.textContent).not.toContain('Grok Build CLI');
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
    const note = screen.getByText(/Sandboxed stage\. Eligible on this install:/);
    expect(note.textContent).toContain('Eligible on this install: Codex TUI, OpenCode TUI.');
    expect(note.textContent).toContain("OS-sandboxed by the vendor's own recipe: Codex TUI.");
    expect(note.textContent).toContain('isolated by the disposable worktree only: OpenCode TUI.');
  });
});
