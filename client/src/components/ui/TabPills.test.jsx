import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
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

  it.each(['underline', 'pills'])('uses a roving tabindex for the %s variant', (variant) => {
    render(<TabPills variant={variant} tabs={sampleTabs} activeTab="places" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: /Cast/i })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: /Places/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Objects/i })).toHaveAttribute('tabindex', '-1');
  });

  it.each(['underline', 'pills'])('navigates tabs with arrow keys and wraps for the %s variant', async (variant) => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TabPills variant={variant} tabs={sampleTabs} activeTab="cast" onChange={onChange} />);

    const castTab = screen.getByRole('tab', { name: /Cast/i });
    const placesTab = screen.getByRole('tab', { name: /Places/i });
    const objectsTab = screen.getByRole('tab', { name: /Objects/i });

    castTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('places');
    expect(document.activeElement).toBe(placesTab);

    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('objects');
    expect(document.activeElement).toBe(objectsTab);

    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('places');
    expect(document.activeElement).toBe(placesTab);

    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('cast');
    expect(document.activeElement).toBe(castTab);

    objectsTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('cast');
    expect(document.activeElement).toBe(castTab);
  });

  it('uses Home and End to move to the first and last enabled tabs', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TabPills tabs={sampleTabs} activeTab="places" onChange={onChange} />);

    const castTab = screen.getByRole('tab', { name: /Cast/i });
    const placesTab = screen.getByRole('tab', { name: /Places/i });
    const objectsTab = screen.getByRole('tab', { name: /Objects/i });

    placesTab.focus();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('cast');
    expect(document.activeElement).toBe(castTab);

    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('objects');
    expect(document.activeElement).toBe(objectsTab);
  });

  it('skips disabled tabs during keyboard navigation', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const tabs = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', disabled: true },
      { id: 'c', label: 'C' },
    ];
    render(<TabPills tabs={tabs} activeTab="a" onChange={onChange} />);

    const aTab = screen.getByRole('tab', { name: 'A' });
    const cTab = screen.getByRole('tab', { name: 'C' });
    aTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('c');
    expect(document.activeElement).toBe(cTab);
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

  // #7420: a bar that mounts one panel at a time only ever has ONE panel in the
  // document, so every OTHER tab's `aria-controls` pointed at an id that did
  // not exist. Only the active tab may claim to control something real.
  it('omits aria-controls from every inactive tab (nothing to control in a one-panel-at-a-time bar)', () => {
    render(<TabPills tabs={sampleTabs} activeTab="cast" onChange={() => {}} controlsIdPrefix="tabpanel" />);
    for (const name of [/Places/i, /Objects/i]) {
      expect(screen.getByRole('tab', { name })).not.toHaveAttribute('aria-controls');
    }
    // `id` stays on every tab: a caller that keeps every panel mounted and
    // toggles `hidden` (rather than conditionally rendering) gives each panel
    // a static `aria-labelledby="tab-<id>"`, which would dangle without it.
    expect(screen.getByRole('tab', { name: /Places/i })).toHaveAttribute('id', 'tab-places');
  });

  it('same contract in the pills variant', () => {
    render(<TabPills variant="pills" tabs={sampleTabs} activeTab="cast" onChange={() => {}} controlsIdPrefix="tabpanel" />);
    const castBtn = screen.getByRole('tab', { name: /Cast/i });
    expect(castBtn).toHaveAttribute('id', 'tab-cast');
    expect(castBtn).toHaveAttribute('aria-controls', 'tabpanel-cast');
    const placesBtn = screen.getByRole('tab', { name: /Places/i });
    expect(placesBtn).not.toHaveAttribute('aria-controls');
    expect(placesBtn).toHaveAttribute('id', 'tab-places');
  });
});

// The preferred phone treatment: the same tab buttons, icons only. A `<select>`
// reads as a form control rather than navigation, so it is reserved for the
// bars that have no icons to show (#7283 made it universal; this reverses that).
describe('TabPills — mobileCompact icon row', () => {
  it('keeps one tablist and hides each label below `sm` without renaming the tab', () => {
    render(<TabPills mobileCompact tabs={sampleTabs} activeTab="cast" onChange={() => {}} />);

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    const castBtn = screen.getByRole('tab', { name: /Cast/ });
    expect(castBtn).toHaveAccessibleName('Cast 3');
    expect(within(castBtn).getByText('Cast')).toHaveClass('max-sm:sr-only');
    expect(castBtn.querySelector('svg')).toBeTruthy();
  });

  it.each(['underline', 'pills'])('reveals a scrollable edge with a chevron in the %s variant', async (variant) => {
    // happy-dom reports every box as 0x0 and ships no ResizeObserver, so both
    // the overflow and the re-measure that publishes it have to be stated. The
    // fake observer is also what proves the split: the scroll path alone never
    // re-reads `scrollWidth`, so without a resize there is nothing to reveal.
    const resize = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { resize.push(cb); }
      observe() {}
      disconnect() {}
    });
    const user = userEvent.setup();
    const { container } = render(
      <TabPills variant={variant} mobileCompact tabs={sampleTabs} activeTab="cast" onChange={() => {}} />
    );
    const strip = container.querySelector('[role="tablist"]');
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
    const scrollBy = vi.spyOn(strip, 'scrollBy').mockImplementation(() => {});

    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull();
    act(() => { for (const cb of resize) cb(); });
    expect(screen.queryByRole('button', { name: 'Scroll tabs left' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Scroll tabs right' }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 240, behavior: 'smooth' });

    strip.scrollLeft = 200;
    fireEvent.scroll(strip);
    await user.click(screen.getByRole('button', { name: 'Scroll tabs left' }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -240, behavior: 'smooth' });
    vi.unstubAllGlobals();
  });

  it('falls back to the labelled <select> when any tab has no icon to show', () => {
    const tabs = [...sampleTabs.slice(0, 2), { id: 'objects', label: 'Objects' }];
    render(
      <TabPills
        variant="pills"
        mobileCompact
        mobileSelectId="ub-tab-select"
        tabs={tabs}
        activeTab="cast"
        onChange={() => {}}
      />
    );
    const select = screen.getByRole('combobox');
    expect(select).toHaveAttribute('id', 'ub-tab-select');
    expect(select.value).toBe('cast');
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull();
    // Count appears in option text when present
    expect(within(select).getByRole('option', { name: /Cast \(3\)/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Objects' })).toBeInTheDocument();
  });

  it('mobile <select> falls back to aria-label when mobileSelectId is omitted', () => {
    render(
      <TabPills
        variant="pills"
        mobileCompact
        ariaLabel="Universe sections"
        tabs={[{ id: 'cast', label: 'Cast' }, { id: 'places', label: 'Places' }]}
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

describe('TabPills — filter variant', () => {
  it('emits toggle-button semantics instead of tab/tablist', () => {
    // A filter chip row narrows rows in place; it never swaps a panel, so
    // promising `role="tab"` (and an aria-controls target that does not exist)
    // misdescribes the control to a screen reader.
    render(<TabPills variant="filter" tabs={sampleTabs} activeTab="cast" onChange={() => {}} ariaLabel="Filter by kind" />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    const group = screen.getByRole('group', { name: 'Filter by kind' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Cast/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Places/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the pills styling and count badges, and reports clicks by id', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TabPills variant="filter" tabs={sampleTabs} activeTab="cast" onChange={onChange} />);
    expect(screen.getByRole('button', { name: /Cast/i })).toHaveTextContent('3');
    await user.click(screen.getByRole('button', { name: /Objects/i }));
    expect(onChange).toHaveBeenCalledWith('objects');
  });
});

it('reveals tabs horizontally without moving ancestors or stealing draft focus', () => {
  const ancestorScroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  const view = (activeTab, tabs) => <><TabPills tabs={tabs} activeTab={activeTab} onChange={vi.fn()} /><input aria-label="Draft" /></>;
  const { rerender } = render(view('cast', []));
  const strip = screen.getByRole('tablist');
  const scroll = vi.spyOn(strip, 'scrollBy').mockImplementation(() => {});
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0 });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 200 });
  rerender(view('cast', sampleTabs));
  const places = screen.getByRole('tab', { name: /Places/ });
  vi.spyOn(places, 'getBoundingClientRect').mockReturnValue({ left: 180, right: 260 });
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  draft.focus();
  rerender(view('places', sampleTabs));
  expect(scroll).toHaveBeenLastCalledWith({ left: 60, behavior: 'smooth' });
  rerender(view('places', sampleTabs.map(tab => ({ ...tab, count: 10 }))));
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(draft).toHaveFocus();
  expect(ancestorScroll).not.toHaveBeenCalled();
  // Selecting a tab clipped at the left edge reveals it in the other direction.
  const cast = screen.getByRole('tab', { name: /Cast/ });
  vi.spyOn(cast, 'getBoundingClientRect').mockReturnValue({ left: -80, right: 20 });
  rerender(view('cast', sampleTabs));
  expect(scroll).toHaveBeenLastCalledWith({ left: -80, behavior: 'smooth' });
  ancestorScroll.mockRestore();
});
