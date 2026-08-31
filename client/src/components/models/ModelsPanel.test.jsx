import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const memory = vi.hoisted(() => ({ publish: null }));
vi.mock('../settings/MemoryManagement.jsx', () => ({
  default: ({ onLoadedModelsChange }) => {
    memory.publish = onLoadedModelsChange;
    return <div>Memory status</div>;
  },
}));

const ModelsPanel = (await import('./ModelsPanel.jsx')).default;

const model = {
  id: 'ollama:example:latest',
  backend: 'ollama',
  name: 'Example model',
  sizeBytes: 1024,
  loaded: false,
  managePath: '/models/llms',
  action: { type: 'local-model', backend: 'ollama', modelId: 'example:latest' },
};
const report = {
  generatedAt: '2026-08-16T00:00:00.000Z',
  sourceErrors: [],
  models: { downloaded: [model], totals: { all: 1024 } },
  cleanupCandidates: [{
    ...model,
    label: model.name,
    estimatedBytes: model.sizeBytes,
    action: model.action,
    busy: false,
    manualOnly: false,
  }],
};
const cleanup = {
  busyId: null,
  locked: false,
  isConfirming: vi.fn(() => false),
  request: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
};

describe('ModelsPanel live residency', () => {
  it('revokes a stale delete action when the model becomes resident', () => {
    render(
      <MemoryRouter>
        <ModelsPanel report={report} loading={false} onRunReport={vi.fn()} cleanup={cleanup} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Remove Example model' })).toBeInTheDocument();

    act(() => memory.publish({
      ollama: [{ id: 'example:latest', name: 'example:latest' }],
      lmstudio: [],
      sourceErrors: [],
    }));

    expect(screen.getByText('loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Example model' })).not.toBeInTheDocument();
  });

  it('fails closed when live residency becomes unknown', () => {
    render(
      <MemoryRouter>
        <ModelsPanel report={report} loading={false} onRunReport={vi.fn()} cleanup={cleanup} />
      </MemoryRouter>,
    );

    act(() => memory.publish({ ollama: [], lmstudio: [], sourceErrors: ['ollama'] }));

    expect(screen.getByText('status unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Example model' })).not.toBeInTheDocument();
  });

  it('hides unavailable sources the user intentionally disabled', () => {
    render(
      <MemoryRouter>
        <ModelsPanel
          report={{
            ...report,
            sourceErrors: ['lmstudio-backend', 'ollama-backend'],
            disabledSources: ['lmstudio'],
          }}
          loading={false}
          onRunReport={vi.fn()}
          cleanup={cleanup}
        />
      </MemoryRouter>,
    );

    const warning = screen.getByText(/Some model sources are unavailable:/);
    expect(warning.textContent).toContain('ollama-backend');
    expect(warning.textContent).not.toContain('lmstudio-backend');
  });
});
