import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import StepSettings from './StepSettings.jsx';

// `model-b` has an EMPTY effort ladder, so selecting it hides the effort select
// entirely — which is what makes the shared selector emit a model change and an
// effort clear back to back, the pair this component has to coalesce.
const PROVIDERS = [
  {
    id: 'agent-a',
    name: 'Agent A',
    type: 'cli',
    enabled: true,
    defaultModel: 'model-a',
    models: ['model-a', 'model-b'],
    effortLevelsByModel: { 'model-a': ['low', 'high'], 'model-b': [] },
  },
  { id: 'agent-b', name: 'Agent B', type: 'cli', enabled: true, defaultModel: 'other-model', models: ['other-model'] },
];

const ENTRY = { kind: 'scheduled', taskType: 'example-task', config: { providerId: 'agent-a', model: 'model-a' } };

// The page owns the job object and re-renders the row with whatever `onChange`
// last handed it — the controlled-parent contract this component is written to.
const renderStep = (job = { id: 'step-1', overrides: {} }) => {
  const onChange = vi.fn();
  const view = render(
    <MemoryRouter>
      <StepSettings job={job} entry={ENTRY} providers={PROVIDERS} idPrefix="step-1" onChange={onChange} />
    </MemoryRouter>,
  );
  const rerender = (next) => view.rerender(
    <MemoryRouter>
      <StepSettings job={next} entry={ENTRY} providers={PROVIDERS} idPrefix="step-1" onChange={onChange} />
    </MemoryRouter>,
  );
  return { onChange, rerender };
};

beforeEach(() => vi.clearAllMocks());

describe('quota-burn StepSettings', () => {
  it('writes a provider override and leaves the others inherited', async () => {
    const { onChange } = renderStep();

    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'agent-b');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      overrides: expect.objectContaining({ providerId: 'agent-b' }),
    }));
  });

  it('clears an override back to null when Inherit is reselected', async () => {
    const { onChange } = renderStep({ id: 'step-1', overrides: { providerId: 'agent-b' } });

    await userEvent.selectOptions(screen.getByLabelText('Provider'), '');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      overrides: expect.objectContaining({ providerId: null }),
    }));
  });

  // The regression this component's emit accumulator exists for: `onChange`
  // REPLACES the whole job, so the effort clear that follows the model change in
  // the same tick would be built from the stale `job` prop and drop the model.
  it('keeps the model when selecting it also clears an effort the model cannot honor', async () => {
    const { onChange } = renderStep({ id: 'step-1', overrides: { providerId: 'agent-a', model: 'model-a', effort: 'high' } });

    await userEvent.selectOptions(screen.getByLabelText('Model'), 'model-b');

    const last = onChange.mock.calls.at(-1)[0];
    expect(last.overrides.model).toBe('model-b');
    expect(last.overrides.effort).toBe(null);
  });

  it('starts the next interaction from the re-rendered job, not the last emit', async () => {
    const { onChange, rerender } = renderStep({ id: 'step-1', overrides: { providerId: 'agent-a' } });

    await userEvent.selectOptions(screen.getByLabelText('Model'), 'model-b');
    rerender({ id: 'step-1', overrides: { providerId: 'agent-a', model: 'model-b' } });
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'agent-b');

    expect(onChange.mock.calls.at(-1)[0].overrides).toEqual({ providerId: 'agent-b', model: 'model-b' });
  });

  it('resolves the model list against the provider an unpinned step would run on', () => {
    renderStep();

    // Nothing is pinned, so the list comes from the task's saved provider
    // (`agent-a`) rather than collapsing to "no models".
    const options = Array.from(screen.getByLabelText('Model').querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('model-a');
    expect(options).toContain('model-b');
  });
});
