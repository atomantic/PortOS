import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CronSchedulePicker from './CronSchedulePicker.jsx';

describe('CronSchedulePicker', () => {
  afterEach(() => vi.useRealTimers());

  it('exposes the advanced cron panel state and relationship', () => {
    render(<CronSchedulePicker value="0 7 * * *" onChange={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: 'Hide advanced' });
    const advancedPanel = document.getElementById(toggle.getAttribute('aria-controls'));

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', advancedPanel.id);

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', advancedPanel.id);
    expect(advancedPanel).toHaveAttribute('hidden');
  });

  it('edits an arbitrary weekly interval without losing the weekday', () => {
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31' }}
        valueShape="recurrence"
        onChange={onChange}
      />,
    );

    expect(screen.getByText('Every 2 weeks on Mon at 02:00')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Tue'));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      frequency: 'weekly', interval: 2, weekdays: [1, 2], anchorDate: '2026-08-31',
    }));
  });

  it('keeps weekly recurrence valid when the last weekday is clicked', () => {
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ frequency: 'weekly', interval: 1, weekdays: [1], time: '02:00' }}
        valueShape="recurrence"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTitle('Mon'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: [1] }));
  });

  it('adapts legacy commission schedules and promotes them to rich recurrence', () => {
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ kind: 'WEEKLY', weekday: 1, atLocalTime: '02:00' }}
        valueShape="commission"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Repeat every number of weeks'), { target: { value: '2' } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'RECURRENCE',
      recurrence: expect.objectContaining({ frequency: 'weekly', interval: 2, weekdays: [1] }),
    }));
  });

  it('anchors new intervals in the configured timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:30:00.000Z'));
    const onChange = vi.fn();
    render(
      <CronSchedulePicker
        value={{ frequency: 'weekly', interval: 1, weekdays: [0], time: '02:00' }}
        valueShape="recurrence"
        timezone="America/Los_Angeles"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Repeat every number of weeks'), { target: { value: '2' } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ anchorDate: '2026-08-30' }));
  });
});
