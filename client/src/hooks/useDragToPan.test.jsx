import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import useDragToPan from './useDragToPan';

function Harness(props) {
  const pan = useDragToPan(props);
  return (
    <div
      ref={pan.surfaceRef}
      data-testid="surface"
      data-panning={pan.isPanning ? 'true' : 'false'}
      {...pan.panProps}
    >
      <button type="button" onClick={props.onButtonClick}>Control</button>
    </div>
  );
}

it('pans past the slop threshold and leaves a tap alone', () => {
  const onClick = vi.fn();
  render(<Harness slop={4} onButtonClick={onClick} />);
  const surface = screen.getByTestId('surface');
  surface.scrollLeft = 100;
  surface.scrollTop = 50;

  // Under the slop threshold: no scroll change, and the click still fires.
  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 202, clientY: 201 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(surface);
  expect(surface.scrollLeft).toBe(100);
  expect(surface.scrollTop).toBe(50);

  // Past the slop threshold: pans, and the ending click is swallowed.
  fireEvent.pointerDown(surface, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 170 });
  fireEvent.pointerUp(surface, { pointerId: 2, pointerType: 'mouse' });
  fireEvent.click(screen.getByRole('button', { name: 'Control' }));
  expect(surface.scrollLeft).toBe(150);
  expect(surface.scrollTop).toBe(80);
  expect(onClick).not.toHaveBeenCalled();
});

it('locks panning to one axis when asked', () => {
  render(<Harness slop={4} axis="x" onButtonClick={vi.fn()} />);
  const surface = screen.getByTestId('surface');
  surface.scrollLeft = 0;
  surface.scrollTop = 0;

  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 140, clientY: 260 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' });

  expect(surface.scrollLeft).toBe(60);
  expect(surface.scrollTop).toBe(0);
});

it('never claims a gesture canStart rejects, so its click still reaches the control', () => {
  const onClick = vi.fn();
  render(
    <Harness
      slop={4}
      onButtonClick={onClick}
      canStart={e => !e.target.closest('button')}
    />,
  );
  const surface = screen.getByTestId('surface');
  const button = screen.getByRole('button', { name: 'Control' });
  surface.scrollLeft = 0;

  fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 140, clientY: 200 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(button);

  expect(surface.scrollLeft).toBe(0);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('never carries a swallowed-click flag into the next unrelated click', () => {
  const onClick = vi.fn();
  render(<Harness slop={4} onButtonClick={onClick} />);
  const surface = screen.getByTestId('surface');
  const button = screen.getByRole('button', { name: 'Control' });

  // A drag that ends without ever producing a click (pointercancel, no click
  // event follows) must not leave the next, unrelated click swallowed.
  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 150, clientY: 200 });
  fireEvent.pointerCancel(surface, { pointerId: 1, pointerType: 'mouse' });

  // The next real click is always preceded by its own pointerdown.
  fireEvent.pointerDown(button, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(button, { pointerId: 2, pointerType: 'mouse' });
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('ignores every gesture while disabled', () => {
  render(<Harness slop={4} enabled={false} onButtonClick={vi.fn()} />);
  const surface = screen.getByTestId('surface');
  surface.scrollLeft = 0;

  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 200 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' });

  expect(surface.scrollLeft).toBe(0);
});

it('fires onPanEnd only for a gesture that actually dragged', () => {
  const onPanEnd = vi.fn();
  render(<Harness slop={4} onPanEnd={onPanEnd} onButtonClick={vi.fn()} />);
  const surface = screen.getByTestId('surface');

  // A tap under the slop threshold never counts as a pan.
  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 201, clientY: 200 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' });
  expect(onPanEnd).not.toHaveBeenCalled();

  fireEvent.pointerDown(surface, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 200 });
  fireEvent.pointerUp(surface, { pointerId: 2, pointerType: 'mouse' });
  expect(onPanEnd).toHaveBeenCalledExactlyOnceWith(true);
});

it('ignores non-mouse pointers so touch scrolling is left to the browser', () => {
  render(<Harness slop={4} onButtonClick={vi.fn()} />);
  const surface = screen.getByTestId('surface');
  surface.scrollLeft = 0;

  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 200 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'touch' });

  expect(surface.scrollLeft).toBe(0);
});
