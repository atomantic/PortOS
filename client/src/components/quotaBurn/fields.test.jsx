import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Coverage for the Quota Burn number field (#3934). The load-bearing behavior:
// an empty or out-of-range draft must not commit (it would 400 the coalesced
// save), and must not silently snap back to the stored value on blur either —
// it stays on screen with an inline reason.

import { NumberField, numberFieldError } from './fields';

const setup = (props = {}) => {
  const onChange = vi.fn();
  render(
    <NumberField
      id="burn-interval"
      label="Check every (minutes)"
      value={15}
      min={5}
      max={720}
      onChange={onChange}
      {...props}
    />
  );
  return { onChange, input: screen.getByLabelText(props.label ?? /Check every/) };
};

describe('numberFieldError', () => {
  it('accepts an in-range number and both bounds', () => {
    expect(numberFieldError('7', { min: 5, max: 720 })).toBeNull();
    expect(numberFieldError('5', { min: 5, max: 720 })).toBeNull();
    expect(numberFieldError('720', { min: 5, max: 720 })).toBeNull();
    expect(numberFieldError('-1', { min: -1, max: 50 })).toBeNull();
  });

  it('rejects empty, blank and non-numeric drafts with the range sentence', () => {
    expect(numberFieldError('', { min: 5, max: 720 })).toBe('Must be between 5 and 720');
    expect(numberFieldError('   ', { min: 5, max: 720 })).toBe('Must be between 5 and 720');
    expect(numberFieldError('abc', { min: 5, max: 720 })).toBe('Must be between 5 and 720');
    expect(numberFieldError('-', { min: -1, max: 50 })).toBe('Must be between -1 and 50');
  });

  it('rejects out-of-range numbers', () => {
    expect(numberFieldError('4', { min: 5, max: 720 })).toBe('Must be between 5 and 720');
    expect(numberFieldError('721', { min: 5, max: 720 })).toBe('Must be between 5 and 720');
  });

  it('phrases a one-sided or absent bound', () => {
    expect(numberFieldError('', { min: 5 })).toBe('Must be 5 or more');
    expect(numberFieldError('', { max: 50 })).toBe('Must be 50 or less');
    expect(numberFieldError('', {})).toBe('Must be a number');
    expect(numberFieldError('9999', {})).toBeNull();
  });
});

describe('NumberField', () => {
  it('commits an in-range edit and keeps the box in sync with it', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.clear(input);
    await user.type(input, '30');
    expect(onChange).toHaveBeenLastCalledWith(30);
    expect(input).toHaveValue(30);
    await user.tab();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an inline error on blur of a cleared box instead of reverting', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.clear(input);
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('Must be between 5 and 720');
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'burn-interval-error');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never commits an out-of-range number and flags it on blur', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.clear(input);
    await user.type(input, '3');
    expect(onChange).not.toHaveBeenCalled();
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('Must be between 5 and 720');
    expect(input).toHaveValue(3);
  });

  it('clears the error as soon as the draft becomes committable again', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.clear(input);
    await user.tab();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.type(input, '45');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(45);
  });

  it('follows the stored value again once a good draft is released', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <NumberField id="burn-interval" label="Check every (minutes)" value={15} min={5} max={720} onChange={onChange} />
    );
    const input = screen.getByLabelText(/Check every/);
    await user.clear(input);
    await user.type(input, '60');
    await user.tab();
    rerender(
      <NumberField id="burn-interval" label="Check every (minutes)" value={90} min={5} max={720} onChange={onChange} />
    );
    expect(input).toHaveValue(90);
  });

  it('accepts the -1 unlimited dispatch-cap sentinel', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup({ id: 'burn-cap', label: 'Dispatch cap per window', value: 5, min: -1, max: 50 });
    await user.clear(input);
    await user.type(input, '-1');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(-1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
