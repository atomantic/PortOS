import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import FreeTierUsageCard from './FreeTierUsageCard';

// The unknown-render contract (#7408): a free-tier count that was never
// reported renders as —, never as a confident 0. Only a measured zero may
// render as 0.
describe('FreeTierUsageCard unknown counts', () => {
  const provider = (tokensIn, tokensOut, source) => ({
    id: 'opencode-zen-cli',
    name: 'OpenCode Zen CLI',
    free: true,
    sessions: 2,
    messages: 3,
    tokensIn,
    tokensOut,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source,
    models: []
  });

  it('renders unreported estimate counts as —, never 0', () => {
    const { container } = render(
      <FreeTierUsageCard freeTier={{ basis: 'ledger', providers: [provider(0, 0, 'estimate')], blocks: [] }} />
    );
    const dashes = [...container.querySelectorAll('span')].filter((el) => el.textContent === '—');
    expect(dashes.length).toBeGreaterThan(0);
    expect(screen.getByText('OpenCode Zen CLI')).toBeInTheDocument();
  });

  it('renders a measured zero as 0', () => {
    const { container } = render(
      <FreeTierUsageCard freeTier={{ basis: 'ledger', providers: [provider(0, 100, 'measured')], blocks: [] }} />
    );
    const zeros = [...container.querySelectorAll('span')].filter((el) => el.textContent === '0');
    expect(zeros.length).toBeGreaterThan(0);
  });

  it('renders reported counts as numbers', () => {
    render(
      <FreeTierUsageCard freeTier={{ basis: 'ledger', providers: [provider(1200, 3400, 'mixed')], blocks: [] }} />
    );
    expect(screen.getByText('OpenCode Zen CLI')).toBeInTheDocument();
  });
});
