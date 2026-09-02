import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RunTaskButton from './RunTaskButton';

const APPS = [
  { id: 'app-1', name: 'Example App', repoPath: '~/code/example-app' },
  { id: 'app-2', name: 'Second App', archived: true },
];

// Place the trigger near the right edge of a phone-width viewport — the case
// that used to push the left-anchored panel off-screen.
function stubViewport({ width = 390, height = 780, rect } = {}) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: height });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 600, bottom: 640, left: 300, right: 360, width: 60, height: 200, x: 300, y: 600,
    ...rect,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RunTaskButton', () => {
  it('fires a plain global run when no active apps exist', async () => {
    const user = userEvent.setup();
    const onTrigger = vi.fn();
    render(<RunTaskButton taskType="review" apps={[]} onTrigger={onTrigger} />);
    await user.click(screen.getByRole('button', { name: /Run Now/i }));
    expect(onTrigger).toHaveBeenCalledWith('review');
  });

  it('runs an install-wide task with NO app even when apps exist', async () => {
    // The regression this guards: an install-wide sweep dispatches once for the
    // WHOLE install, but the picker only ever calls onTrigger WITH an appId. Left
    // to the default branch, every click on a machine that has apps would quietly
    // reduce the sweep to a single repo, and the install-wide lane would be
    // unreachable from the UI entirely.
    const user = userEvent.setup();
    const onTrigger = vi.fn();
    render(<RunTaskButton taskType="repo-sync" apps={APPS} onTrigger={onTrigger} installWide />);
    await user.click(screen.getByRole('button', { name: /Run on All Apps/i }));
    expect(onTrigger).toHaveBeenCalledWith('repo-sync');
    expect(onTrigger.mock.calls[0]).toHaveLength(1);
    expect(screen.queryByText('Example App')).toBeNull();
  });

  it('lists only active apps and runs the task on the picked one', async () => {
    const user = userEvent.setup();
    const onTrigger = vi.fn();
    render(<RunTaskButton taskType="review" apps={APPS} onTrigger={onTrigger} />);
    await user.click(screen.getByRole('button', { name: /Run on App/i }));
    expect(screen.queryByText('Second App')).toBeNull();
    await user.click(screen.getByText('Example App'));
    expect(onTrigger).toHaveBeenCalledWith('review', 'app-1');
    // Picking an app dismisses the panel.
    expect(screen.queryByText('Example App')).toBeNull();
  });

  it('shows sending progress and keeps a receipt at the app-card action', async () => {
    const user = userEvent.setup();
    let resolveTrigger;
    const onTrigger = vi.fn(() => new Promise(resolve => { resolveTrigger = resolve; }));
    render(<RunTaskButton taskType="review" apps={APPS} onTrigger={onTrigger} />);

    await user.click(screen.getByRole('button', { name: /Run on App/i }));
    await user.click(screen.getByText('Example App'));

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Sending request');

    await act(async () => { resolveTrigger({ id: 'request-1' }); });

    expect(screen.getByRole('status')).toHaveTextContent('Request sent to Example App');
    expect(screen.getByText('Request sent to Example App')).toBeVisible();
    expect(screen.getByRole('button', { name: /Run on App/i })).toBeEnabled();
  });

  it('keeps the app panel inside the viewport on a phone-width screen', async () => {
    stubViewport();
    const user = userEvent.setup();
    render(<RunTaskButton taskType="review" apps={APPS} onTrigger={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Run on App/i }));

    const panel = screen.getByText('Example App').closest('div.fixed');
    expect(panel).toBeTruthy();
    const left = Number.parseFloat(panel.style.left);
    const width = Number.parseFloat(panel.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    // The pre-migration panel was pinned to the trigger's left edge and only
    // narrowed by max-w, so it ran past the right edge instead of moving.
    expect(left + width).toBeLessThanOrEqual(window.innerWidth - 8);
  });
});
