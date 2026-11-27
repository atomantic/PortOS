import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TribeCircleMap from './TribeCircleMap.jsx';

afterEach(() => vi.restoreAllMocks());

it('exposes contact buttons and keeps keyboard focus visible until blur', () => {
  const contact = { id: 'a', name: 'Example Contact', ring: 'support' };
  const onSelect = vi.fn();
  render(<TribeCircleMap contacts={[contact]} onSelect={onSelect} />);

  const map = screen.getByRole('group', { name: /concentric map/i });
  const button = within(map).getByRole('button', { name: /example contact.*support/i });
  expect(button.tabIndex).toBe(0);
  expect(within(map).getByText('Me').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true');

  fireEvent.focus(button);
  expect(button.querySelectorAll('circle[vector-effect="non-scaling-stroke"]')).toHaveLength(2);
  fireEvent.mouseEnter(button);
  fireEvent.mouseLeave(button);
  expect(screen.getByText(contact.name)).toBeInTheDocument();

  fireEvent.keyDown(button, { key: 'Enter' });
  fireEvent.keyDown(button, { key: ' ' });
  fireEvent.click(button);
  expect(onSelect.mock.calls).toEqual([[contact], [contact], [contact]]);

  fireEvent.blur(button);
  expect(button.querySelector('circle[vector-effect="non-scaling-stroke"]')).toBeNull();
  expect(screen.queryByText(contact.name)).toBeNull();
});

it('clamps external contact tooltips at both sides and flips below top-edge contacts', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(64);

  const contacts = Array.from({ length: 40 }, (_, i) => ({
    id: String(i), name: `Example ${i}`, ring: 'external',
  }));
  render(<TribeCircleMap contacts={contacts} />);
  const map = screen.getByRole('group', { name: /concentric map/i });
  const buttons = within(map).getAllByRole('button');
  expect(buttons).toHaveLength(contacts.length);
  const points = buttons.map((button) => {
    const [x, y] = button.getAttribute('transform').slice(10, -1).split(' ').map(Number);
    return { button, x, y };
  });

  const leftmost = points.toSorted((a, b) => a.x - b.x)[0];
  const rightmost = points.toSorted((a, b) => b.x - a.x)[0];
  for (const [point, left] of [[leftmost, '0px'], [rightmost, '100px']]) {
    fireEvent.mouseEnter(point.button);
    expect(map.nextElementSibling.style.left).toBe(left);
    fireEvent.mouseLeave(point.button);
  }

  const topmost = points.toSorted((a, b) => a.y - b.y)[0];
  fireEvent.focus(topmost.button);
  expect(Number.parseFloat(map.nextElementSibling.style.top)).toBeCloseTo(topmost.y / 880 * 320 + 14);
  fireEvent.blur(topmost.button);

  const bottommost = points.toSorted((a, b) => b.y - a.y)[0];
  fireEvent.mouseEnter(bottommost.button);
  expect(Number.parseFloat(map.nextElementSibling.style.top)).toBeCloseTo(bottommost.y / 880 * 320 - 14 - 64);
});
