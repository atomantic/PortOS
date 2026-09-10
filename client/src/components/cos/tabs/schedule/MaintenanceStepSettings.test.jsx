import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MaintenanceStepSettings from './MaintenanceStepSettings';
import { updateMaintenanceStep } from '../../../../services/apiAgents';

vi.mock('../../../../services/apiAgents', () => ({ updateMaintenanceStep: vi.fn() }));
const providers = [{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', enabled: true, models: ['example-one', 'example-two'] }];
const step = { id: 'step-2', taskRef: { taskType: 'simplify' }, overrides: { providerId: 'codex', model: 'example-one', effort: 'high' } };
const run = { id: 'maint-1', status: 'running', completed: {}, active: { stepId: 'step-1' } };
beforeEach(() => vi.resetAllMocks());

it('saves pending stage settings and surfaces rejection without applying failed edits', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<MaintenanceStepSettings run={run} step={step} providers={providers} onSaved={onSaved} />);
  expect(screen.getByRole('button', { name: 'Save stage' })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Model'), 'example-two');
  await user.selectOptions(screen.getByRole('combobox', { name: /effort/i }), 'low');
  updateMaintenanceStep.mockRejectedValueOnce(new Error('Stage already started'));
  await user.click(screen.getByRole('button', { name: 'Save stage' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Stage already started');
  expect(onSaved).not.toHaveBeenCalled();
  updateMaintenanceStep.mockResolvedValueOnce({ run });
  await user.click(screen.getByRole('button', { name: 'Save stage' }));
  expect(updateMaintenanceStep).toHaveBeenLastCalledWith('maint-1', 'step-2', { providerId: 'codex', model: 'example-two', effort: 'low' }, { silent: true });
  expect(onSaved).toHaveBeenCalledWith(run);
});

it('removes editing when a live update marks the stage dispatched', () => {
  const { rerender } = render(<MaintenanceStepSettings run={run} step={step} providers={providers} />);
  expect(screen.getByLabelText('Provider')).toBeInTheDocument();
  rerender(<MaintenanceStepSettings run={{ ...run, active: { stepId: step.id } }} step={step} providers={providers} />);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  rerender(<MaintenanceStepSettings run={run} step={{ ...step, startedAt: '2026-01-01' }} providers={providers} />);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
