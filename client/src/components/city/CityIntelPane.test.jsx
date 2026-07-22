import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CityIntelPane from './CityIntelPane';

function renderPane(props = {}) {
  return render(
    <MemoryRouter>
      <CityIntelPane apps={[]} cosAgents={[]} instances={[]} eventLogs={[]} {...props} />
    </MemoryRouter>
  );
}

describe('CityIntelPane tab bar', () => {
  it('exposes exactly the three intel tabs in a labelled tablist', () => {
    renderPane();
    const list = screen.getByRole('tablist', { name: 'Intel' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.textContent)).toEqual(['ATTENTION', 'TIMELINE', 'ACTIVITY']);
    // The collapse toggle is a sibling of the tablist, not a child of it —
    // a non-tab child would be an invalid `role="tablist"` owner.
    expect(list).not.toContainElement(screen.getByRole('button', { name: /collapse intel pane/i }));
  });

  it('wires aria-selected, roving tabindex, and aria-controls to a matching tabpanel', () => {
    renderPane();
    const [attention, timeline] = screen.getAllByRole('tab');
    expect(attention).toHaveAttribute('aria-selected', 'true');
    expect(attention).toHaveAttribute('tabindex', '0');
    expect(timeline).toHaveAttribute('aria-selected', 'false');
    expect(timeline).toHaveAttribute('tabindex', '-1');

    const panel = screen.getByRole('tabpanel');
    expect(attention.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(attention.id);
    // Only one panel is mounted, so an unselected tab must not point at a
    // nonexistent element.
    expect(timeline).not.toHaveAttribute('aria-controls');
    // An empty panel has no focusable children — it must be its own tab stop.
    expect(panel).toHaveAttribute('tabindex', '0');
  });

  it('moves selection and focus with arrow keys and wraps, and jumps with Home/End', () => {
    renderPane();
    const tabs = () => screen.getAllByRole('tab');
    const step = (from, key, to) => {
      fireEvent.keyDown(tabs()[from], { key });
      expect(tabs()[to]).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(tabs()[to]);
    };
    step(0, 'ArrowRight', 1);
    step(1, 'End', 2);
    step(2, 'ArrowRight', 0); // wraps forward
    step(0, 'ArrowLeft', 2); // wraps backward
    step(2, 'Home', 0);
  });

  it('collapses the panel and drops the stale aria-controls reference', () => {
    renderPane();
    const toggle = screen.getByRole('button', { name: /collapse intel pane/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);

    expect(screen.queryByRole('tabpanel')).toBeNull();
    const expand = screen.getByRole('button', { name: /expand intel pane/i });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).not.toHaveAttribute('aria-controls');
    // Selection survives the collapse; the tab just has no rendered panel to own.
    const [attention] = screen.getAllByRole('tab');
    expect(attention).toHaveAttribute('aria-selected', 'true');
    expect(attention).not.toHaveAttribute('aria-controls');
  });

  it('re-expands when a tab is clicked while collapsed', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /collapse intel pane/i }));
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
  });
});
