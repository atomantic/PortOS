import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TribeCareWidget from './TribeCareWidget';

const renderWidget = (tribeCare) =>
  render(
    <MemoryRouter>
      <TribeCareWidget dashboardState={{ tribeCare }} />
    </MemoryRouter>
  );

describe('TribeCareWidget', () => {
  it('renders nothing when the tribe has no people', () => {
    const { container } = renderWidget({ hasPeople: false, overdueCount: 0, overdue: [] });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the summary is absent (fetch failed)', () => {
    const { container } = renderWidget(null);
    expect(container.firstChild).toBeNull();
  });

  it('shows an all-caught-up state when nobody is overdue', () => {
    renderWidget({ hasPeople: true, peopleCount: 3, overdueCount: 0, overdue: [] });
    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  it('lists overdue people with deep links and an overflow count', () => {
    renderWidget({
      hasPeople: true,
      peopleCount: 5,
      overdueCount: 4,
      overdue: [
        { id: 'a', name: 'Ada', state: 'overdue', daysOverdue: 12 },
        { id: 'b', name: 'Bo', state: 'missing', daysOverdue: null },
      ],
    });
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('12d overdue')).toBeTruthy();
    expect(screen.getByText('no touchpoint')).toBeTruthy();
    // 4 overdue total, 2 shown → "+2 more overdue"
    expect(screen.getByText('+2 more overdue')).toBeTruthy();
    // Every row links into the Tribe page.
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links.every((href) => href === '/tribe')).toBe(true);
  });
});
