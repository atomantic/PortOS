import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import socket from '../../services/socket';
import DeployPanel from './DeployPanel';

vi.mock('../../services/socket', () => ({
  default: {
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    volatile: { timeout: vi.fn(() => ({ emit: cancelEmit })) },
  },
}));

const cancelEmit = vi.hoisted(() => vi.fn());

beforeEach(() => vi.clearAllMocks());

function renderPanel() {
  render(<><button type="button">Outside</button><DeployPanel appId="app-1" appName="Example App" /></>);
  return screen.getByRole('button', { name: 'Deploy options' });
}

describe('DeployPanel', () => {
  it('dismisses options on Escape and outside pointerdown, while keeping flag selections', () => {
    const options = renderPanel();
    fireEvent.click(options);
    const ios = screen.getByRole('checkbox', { name: 'iOS' });
    expect(ios).toHaveFocus();
    fireEvent.pointerDown(ios);
    fireEvent.click(ios);
    expect(ios).toBeChecked();

    fireEvent.keyDown(ios, { key: 'Escape' });
    expect(screen.queryByRole('checkbox', { name: 'iOS' })).not.toBeInTheDocument();
    expect(options).toHaveFocus();

    fireEvent.click(options);
    expect(screen.getByRole('checkbox', { name: 'iOS' })).toBeChecked();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(options).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: 'iOS' })).not.toBeInTheDocument();
  });

  it('confirms script defaults and allows cancellation without dispatch', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy', exact: true }));
    const confirm = screen.getByRole('group', { name: /Deploy Example App/ });
    expect(confirm).toHaveTextContent('No flags selected (script defaults).');
    expect(confirm).toHaveFocus();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(confirm).not.toBeInTheDocument();
    expect(socket.emit).not.toHaveBeenCalledWith('app:deploy', expect.anything());
  });

  it('dispatches only after confirming the app and its flags, then reopens live output in one click', () => {
    const options = renderPanel();
    fireEvent.click(options);
    fireEvent.click(screen.getByRole('checkbox', { name: 'iOS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skip Tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deploy (--ios --skip-tests)' }));
    const confirm = screen.getByRole('group', { name: /Deploy Example App/ });
    expect(confirm).toHaveTextContent('Flags: --ios --skip-tests');
    expect(socket.emit).not.toHaveBeenCalledWith('app:deploy', expect.anything());

    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm deploy' }));
    expect(socket.emit).toHaveBeenCalledWith('app:deploy', { appId: 'app-1', flags: ['--ios', '--skip-tests'] });
    fireEvent.click(screen.getByRole('button', { name: 'Hide deploy output' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View deploy…' }));
    expect(screen.getByRole('dialog', { name: 'Deploy: Example App' })).toBeInTheDocument();
    expect(socket.emit.mock.calls.filter(([event]) => event === 'app:deploy')).toHaveLength(1);
  });

  it.each([
    { cancelled: true, timedOut: false, error: 'Deploy cancelled' },
    { cancelled: false, timedOut: true, error: 'Deploy timed out' },
  ])('shows "$error" after a deploy settles', (outcome) => {
    renderPanel();
    const receive = (event, payload) => act(() => {
      socket.on.mock.calls.find(([name]) => name === event)[1](payload);
    });
    receive('app:operations:active', {
      operations: [{ appId: 'app-1', type: 'deploy', startedAt: 1000 }],
    });

    if (outcome.cancelled) {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel deploy' }));
      expect(cancelEmit).toHaveBeenCalledExactlyOnceWith('app:deploy:cancel', { appId: 'app-1' }, expect.any(Function));
      expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();

      const firstReply = cancelEmit.mock.calls[0][2];
      act(() => firstReply(null, { ok: false, code: 'DEPLOY_CANCEL_FAILED', message: 'Could not cancel deploy' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Could not cancel deploy');
      expect(screen.getByRole('button', { name: 'Cancel deploy' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Hide deploy output' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel deploy' }));
      const secondReply = cancelEmit.mock.calls[1][2];
      act(() => secondReply(null, { ok: true }));
      expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    }

    receive('app:deploy:error', { appId: 'app-1', startedAt: 1000, message: outcome.error });
    receive('app:deploy:complete', { appId: 'app-1', startedAt: 1000, success: false, code: -1, ...outcome });
    expect(screen.getByText(outcome.error)).toBeVisible();
    expect(screen.queryByText(/Deploy failed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel deploy|Cancelling/ })).not.toBeInTheDocument();
  });
});
