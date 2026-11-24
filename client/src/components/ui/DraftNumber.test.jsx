import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DraftNumber from './DraftNumber';

function Host({ start, ...props }) {
  const [value, setValue] = useState(start);
  return <><DraftNumber value={value} onCommit={setValue} {...props}>{(field) => <input type="number" aria-label="n" {...field} />}</DraftNumber><output>{String(value)}</output></>;
}
const box = () => screen.getByLabelText('n');
const type = (text) => fireEvent.change(box(), { target: { value: text } });
const committed = () => screen.getByRole('status').textContent;

it('lets a number below the minimum be typed digit by digit and shows the clamped value after blur', () => {
  render(<Host start={40} min={10} max={200} />);
  type('2');
  expect(box()).toHaveValue(2);
  type('25');
  expect(committed()).toBe('25');
  type('7');
  fireEvent.blur(box());
  expect(box()).toHaveValue(10);
  expect(committed()).toBe('10');
});

it('keeps the value while the box is cleared, unless blank is a value', () => {
  const { unmount } = render(<Host start={3} min={1} integer />);
  type('');
  expect(box()).toHaveValue(null);
  expect(committed()).toBe('3');
  fireEvent.blur(box());
  expect(box()).toHaveValue(3);
  unmount();

  render(<Host start={30} min={10} blankable />);
  type('');
  expect(committed()).toBe('undefined');
});
