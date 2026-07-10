import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WeekdayTimePicker from './WeekdayTimePicker';

describe('WeekdayTimePicker', () => {
  it('marks the days present in the cron as pressed', () => {
    render(<WeekdayTimePicker value="0 9 * * 1,3" onChange={vi.fn()} />);
    expect(screen.getByTitle('Mon')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTitle('Wed')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTitle('Tue')).toHaveAttribute('aria-pressed', 'false');
  });

  it('adds a day to the cron when its pill is clicked', () => {
    const onChange = vi.fn();
    render(<WeekdayTimePicker value="0 9 * * 1" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Fri'));
    expect(onChange).toHaveBeenCalledWith('0 9 * * 1,5');
  });

  it('removes a day when an active pill is clicked', () => {
    const onChange = vi.fn();
    render(<WeekdayTimePicker value="0 9 * * 1,5" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Mon'));
    expect(onChange).toHaveBeenCalledWith('0 9 * * 5');
  });

  it('rebuilds the cron when the time changes', () => {
    const onChange = vi.fn();
    render(<WeekdayTimePicker value="0 9 * * 1" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '14:30' } });
    expect(onChange).toHaveBeenCalledWith('30 14 * * 1');
  });

  it('shows no days selected for an interval cron the picker cannot represent', () => {
    render(<WeekdayTimePicker value="*/15 * * * *" onChange={vi.fn()} />);
    expect(screen.getByTitle('Mon')).toHaveAttribute('aria-pressed', 'false');
    // First interaction converts it into a simple day+time cron at the default time.
  });
});
