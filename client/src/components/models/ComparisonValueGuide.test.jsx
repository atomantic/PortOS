import { expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ComparisonValueGuide from './ComparisonValueGuide';
const row = (model, effort, score, cost, estimated = false) => ({ id: `${model}:${effort}`, model, effort, quality: { value: score, estimated }, costPerTask: cost === null ? null : { value: cost, estimated } });

it('finds cheaper near-peak efforts and cross-model alternatives without using estimated or missing task costs', () => {
  render(<ComparisonValueGuide rows={[
    row('luna', 'high', 36.5, 0.03), row('luna', 'max', 37, 0.07),
    row('astra', 'low', 37, 0.6), row('astra', 'high', 50, 2),
    row('sol', 'high', 37, 0.9), row('unmeasured', 'max', 99, 0.001, true), row('missing', 'high', 98, null),
  ]} />);
  const cards = screen.getAllByRole('article');
  const luna = cards.find(card => within(card).queryByRole('heading', { name: 'luna' }));
  const sol = cards.find(card => within(card).queryByRole('heading', { name: 'sol' }));
  expect(luna).toHaveTextContent('high · 36.5 points · $0.03/task');
  expect(sol).toHaveTextContent('Cheaper peer: luna (high)');
  expect(sol).toHaveTextContent('Better measured cost/performance: luna (max)');
  expect(screen.getAllByText(/Research needed:/)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Acceptable intelligence difference'), { target: { value: '0' } });
  expect(luna).toHaveTextContent('max · 37 points · $0.07/task');
  expect(sol).toHaveTextContent('Cheaper peer: luna (max)');
  expect(luna).not.toHaveTextContent('unmeasured');
});
