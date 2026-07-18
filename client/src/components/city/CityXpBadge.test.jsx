import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CityXpBadge from './CityXpBadge';

const renderBadge = (character) =>
  render(
    <MemoryRouter initialEntries={['/city']}>
      <CityXpBadge character={character} />
    </MemoryRouter>,
  );

describe('CityXpBadge birth-date CTA (#2757)', () => {
  it('shows the numeric level and % caption when a level exists', () => {
    renderBadge({ level: 7, ageYears: 7.5, birthDateStatus: 'ok' });
    expect(screen.getByText('LV 7')).toBeInTheDocument();
    expect(screen.queryByText('LV —')).not.toBeInTheDocument();
    expect(screen.queryByText('LV !')).not.toBeInTheDocument();
  });

  it('shows the SET prompt (LV —) for a genuinely unset date', () => {
    renderBadge({ level: null, ageYears: null, birthDateStatus: 'unset' });
    expect(screen.getByText('LV —')).toBeInTheDocument();
    expect(screen.getByText('SET BIRTH DATE')).toBeInTheDocument();
    expect(screen.getByTitle('Set your birth date')).toBeInTheDocument();
  });

  it('shows the FIX prompt (LV !) in the warning style for a present-but-unusable date', () => {
    for (const status of ['invalid', 'future', 'unreadable']) {
      const { unmount } = renderBadge({ level: null, ageYears: null, birthDateStatus: status });
      expect(screen.getByText('LV !')).toBeInTheDocument();
      expect(screen.getByText('FIX BIRTH DATE')).toBeInTheDocument();
      // Warning-colored, not the normal cyan accent (changelog promise).
      expect(screen.getByText('LV !').className).toMatch(/text-port-warning/);
      unmount();
    }
  });

  it('degrades to the SET prompt instead of crashing if status is "ok" with no level (invariant break)', () => {
    // birthDateCta('ok') is null; the badge must not throw on cta.badgeLabel — it falls back to
    // the SET prompt (claude review defensive gate). Rendering without throwing is the assertion.
    renderBadge({ level: null, ageYears: null, birthDateStatus: 'ok' });
    expect(screen.getByText('LV —')).toBeInTheDocument();
  });
});
