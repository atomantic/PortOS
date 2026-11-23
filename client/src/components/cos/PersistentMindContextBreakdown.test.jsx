import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import PersistentMindContextBreakdown from './PersistentMindContextBreakdown';

it('labels every column of the per-family detail table', () => {
  const breakdown = {
    categories: [{ id: 'tool_definitions', label: 'Tool definitions', tokens: 800, percent: 8, detail: [{ id: 'recipes', label: 'recipes', tokens: 700, tools: 2 }] }],
  };
  render(<PersistentMindContextBreakdown breakdown={breakdown} />);
  const headers = screen.getAllByRole('columnheader');
  expect(headers.map((h) => h.textContent)).toEqual(['Category', 'Component', 'Tokens']);
  headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'));
});
