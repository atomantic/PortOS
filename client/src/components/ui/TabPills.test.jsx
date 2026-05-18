import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Users, MapPin, Package } from 'lucide-react';

import TabPills from './TabPills';

const sampleTabs = [
  { id: 'cast', label: 'Cast', icon: Users, count: 3 },
  { id: 'places', label: 'Places', icon: MapPin, count: 0 },
  { id: 'objects', label: 'Objects', icon: Package },
];

describe('TabPills — underline variant (default)', () => {
  it('renders one button per tab with role="tab" and aria-selected on the active one', () => {
    render(<TabPills tabs={sampleTabs} activeTab="places" onChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.find((t) => t.textContent.includes('Cast'))).toHaveAttribute('aria-selected', 'false');
    expect(tabs.find((t) => t.textContent.includes('Places'))).toHaveAttribute('aria-selected', 'true');
  });

  it('fires onChange with the tab id when a tab is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TabPills tabs={sampleTabs} activeTab="cast" onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: /Places/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('places');
  });

  it('shows the count next to the label when count > 0, hides it at 0 or undefined', () => {
    render(<TabPills tabs={sampleTabs} activeTab="cast" onChange={() => {}} />);
    const castBtn = screen.getByRole('tab', { name: /Cast/i });
    expect(within(castBtn).getByText('3')).toBeInTheDocument();
    const placesBtn = screen.getByRole('tab', { name: /Places/i });
    expect(within(placesBtn).queryByText('0')).not.toBeInTheDocument();
  });

  it('filters out falsy tab entries (so callers can use `cond && {...}`)', () => {
    const tabs = [
      { id: 'a', label: 'A' },
      false,
      null,
      { id: 'b', label: 'B' },
    ];
    render(<TabPills tabs={tabs} activeTab="a" onChange={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('wires aria-controls + button id when controlsIdPrefix is provided', () => {
    render(<TabPills tabs={sampleTabs} activeTab="cast" onChange={() => {}} controlsIdPrefix="tabpanel" />);
    const castBtn = screen.getByRole('tab', { name: /Cast/i });
    expect(castBtn).toHaveAttribute('id', 'tab-cast');
    expect(castBtn).toHaveAttribute('aria-controls', 'tabpanel-cast');
  });
});

describe('TabPills — pills variant', () => {
  it('renders a hidden mobile <select> with all labels when mobileDropdown is set', () => {
    render(
      <TabPills
        variant="pills"
        mobileDropdown
        mobileSelectId="ub-tab-select"
        tabs={sampleTabs}
        activeTab="cast"
        onChange={() => {}}
      />
    );
    const select = screen.getByRole('combobox');
    expect(select).toHaveAttribute('id', 'ub-tab-select');
    expect(select.value).toBe('cast');
    // Count appears in option text when present
    expect(within(select).getByRole('option', { name: /Cast \(3\)/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Objects' })).toBeInTheDocument();
  });

  it('mobile <select> falls back to aria-label when mobileSelectId is omitted', () => {
    render(
      <TabPills
        variant="pills"
        mobileDropdown
        ariaLabel="Universe sections"
        tabs={sampleTabs}
        activeTab="cast"
        onChange={() => {}}
      />
    );
    // No <label> renders without an id, so the accessible name must come from aria-label
    const select = screen.getByRole('combobox', { name: 'Universe sections' });
    expect(select).toHaveAttribute('aria-label', 'Universe sections');
    expect(select).not.toHaveAttribute('id');
  });
});

describe('TabPills — runningKind', () => {
  it('swaps the icon for a spinner when a tab.runningKind matches the active runningKind', () => {
    const tabs = [
      { id: 'a', label: 'A', icon: Users, runningKind: 'fetch' },
      { id: 'b', label: 'B', icon: MapPin, runningKind: 'render' },
    ];
    const { container } = render(
      <TabPills tabs={tabs} activeTab="a" onChange={() => {}} runningKind="fetch" />
    );
    // Lucide renders an SVG with `lucide-loader-2` class on the spinner.
    expect(container.querySelector('.lucide-loader-2, .lucide-loader-circle')).toBeTruthy();
  });
});

describe('TabPills — trailing slot', () => {
  it('renders t.trailing inside the tab button after the count, in both variants', () => {
    const tabs = [
      { id: 'a', label: 'A', count: 2, trailing: <span data-testid="dot-a" /> },
      { id: 'b', label: 'B', trailing: <span data-testid="dot-b" /> },
    ];
    // underline variant
    const { rerender } = render(<TabPills tabs={tabs} activeTab="a" onChange={() => {}} />);
    const aBtn = screen.getByRole('tab', { name: /A/i });
    expect(within(aBtn).getByTestId('dot-a')).toBeInTheDocument();
    // Count node sits before the trailing node in DOM order so the dot trails it.
    const children = Array.from(aBtn.children);
    const countIdx = children.findIndex((c) => c.textContent === '2');
    const dotIdx = children.findIndex((c) => c.getAttribute('data-testid') === 'dot-a');
    expect(countIdx).toBeGreaterThanOrEqual(0);
    expect(dotIdx).toBeGreaterThan(countIdx);
    // pills variant: same contract
    rerender(<TabPills variant="pills" tabs={tabs} activeTab="a" onChange={() => {}} />);
    expect(within(screen.getByRole('tab', { name: /B/i })).getByTestId('dot-b')).toBeInTheDocument();
  });
});
