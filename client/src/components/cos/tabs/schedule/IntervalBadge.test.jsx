import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import IntervalBadge from './IntervalBadge';

const APP_CRON = [{ appId: 'acme', appName: 'Acme', cronExpression: '*/15 * * * *' }];

afterEach(cleanup);

// A globally on-demand task an app runs on a cron used to show "On Demand"
// beside "1 app schedule", which reads as the task never running by itself.
describe('IntervalBadge', () => {
  it('lets the app schedule chip stand alone when the global row is plain on-demand', () => {
    render(<IntervalBadge type="on-demand" appSchedules={APP_CRON} />);
    expect(screen.queryByText('On Demand')).toBeNull();
    expect(screen.getByText('1 app schedule').getAttribute('title')).toContain('every other app runs it only when triggered');
  });

  it('keeps the cadence chip when no app has a schedule, or the global row has its own clock', () => {
    render(<IntervalBadge type="on-demand" appSchedules={[]} />);
    expect(screen.getByText('On Demand')).toBeTruthy();
    cleanup();
    render(<IntervalBadge type="cron" cronExpression="0 9 * * *" appSchedules={APP_CRON} />);
    expect(screen.getByText('1 app schedule')).toBeTruthy();
    expect(screen.getByText('Scheduled')).toBeTruthy();
  });
});
