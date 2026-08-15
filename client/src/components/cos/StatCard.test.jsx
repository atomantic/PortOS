import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StatCard from './StatCard';

// `activeLabel` used to be rendered ONLY by the default variant — the `compact`
// and `mini` variants folded it into the aria-label and dropped it from the
// markup, so a sighted user saw nothing (#4129). Every variant now paints it.
const VARIANTS = [
  ['default', {}],
  ['compact', { compact: true }],
  ['mini', { mini: true }],
];

const root = (container) => container.firstChild;

describe('StatCard activeLabel', () => {
  for (const [name, variantProps] of VARIANTS) {
    it(`renders the active sub-label visibly in the ${name} variant`, () => {
      render(<StatCard label="Learning" value="84%" activeLabel="3 skipped" active {...variantProps} />);
      expect(screen.getByText('3 skipped')).toBeInTheDocument();
    });

    it(`announces the active sub-label in the ${name} variant's accessible name`, () => {
      render(<StatCard label="Learning" value="84%" activeLabel="3 skipped" active {...variantProps} />);
      expect(screen.getByRole('group', { name: 'Learning: 84%, 3 skipped' })).toBeInTheDocument();
    });

    it(`omits the sub-label when the ${name} variant is not active`, () => {
      render(<StatCard label="Learning" value="84%" activeLabel="3 skipped" {...variantProps} />);
      expect(screen.queryByText('3 skipped')).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Learning: 84%' })).toBeInTheDocument();
    });
  }

  it('truncates the sub-label so it clips inside the card instead of spilling', () => {
    render(<StatCard label="Learning" value="84%" activeLabel="3 skipped" active compact />);
    expect(screen.getByText('3 skipped').classList.contains('truncate')).toBe(true);
  });
});

describe('StatCard onClick', () => {
  it('stays a labelled group — not a button — without onClick', () => {
    render(<StatCard label="Active" value={2} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Active: 2' })).toBeInTheDocument();
  });

  it('promotes the card to a real button that fires on click', async () => {
    const onClick = vi.fn();
    render(<StatCard label="Learning" value="84%" onClick={onClick} compact />);

    const button = screen.getByRole('button', { name: 'Learning: 84%' });
    // type="button" keeps a card inside a form from submitting it.
    expect(button.getAttribute('type')).toBe('button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('offers a border-hover affordance while the border is still neutral', () => {
    const { container } = render(<StatCard label="Learning" value="84%" onClick={() => {}} mini />);
    expect(root(container).className).toContain('hover:border-port-accent-2/50');
  });

  it('does not hover-recolor a border already carrying a tone or the active accent', () => {
    // Hovering a red "critical" card must not flash it accent-2 — the health
    // color is the signal, and Tailwind's hover: variant would win over it.
    const { container: toned } = render(<StatCard label="Learning" value="12%" onClick={() => {}} tone="critical" mini />);
    expect(root(toned).className).not.toContain('hover:border-');

    const { container: activeCard } = render(<StatCard label="Active" value={2} onClick={() => {}} active mini />);
    expect(root(activeCard).className).not.toContain('hover:border-');
  });

  it('passes title through for the hover hint', () => {
    render(<StatCard label="Learning" value="84%" title="2 need attention" onClick={() => {}} mini />);
    expect(screen.getByRole('button', { name: 'Learning: 84%' }).getAttribute('title')).toBe('2 need attention');
  });
});

describe('StatCard tone', () => {
  it('paints border, icon and sub-label from one tone entry', () => {
    const { container } = render(
      <StatCard label="Learning" value="12%" icon={<svg data-testid="icon" />} activeLabel="3 skipped" active tone="critical" mini />,
    );

    expect(root(container).className).toContain('border-port-error');
    expect(screen.getByTestId('icon').parentElement.className).toContain('text-port-error');
    expect(screen.getByText('3 skipped').className).toContain('text-port-error');
  });

  it('lets the tone border win over the generic active accent', () => {
    // `active` also drives the pulsing accent border; a card carrying a health
    // tone must read as that health state, not as "something is running".
    const { container } = render(<StatCard label="Learning" value="12%" active tone="warning" compact />);
    expect(root(container).className).toContain('border-port-warning');
    expect(root(container).className).not.toContain('border-port-accent');
  });

  it('tints only the icon for the good tone, leaving the border to active', () => {
    const { container } = render(<StatCard label="Learning" value="98%" icon={<svg data-testid="icon" />} tone="good" mini />);
    expect(screen.getByTestId('icon').parentElement.className).toContain('text-port-accent-2');
    expect(root(container).className).toContain('border-port-border');
  });

  it('falls back to the neutral tone for a status it does not know', () => {
    // The learning summary also emits `ok` / `none`; an unmapped tone must go
    // gray rather than inherit whatever text color the page happens to set.
    render(<StatCard label="Learning" value="—" icon={<svg data-testid="icon" />} tone="none" mini />);
    expect(screen.getByTestId('icon').parentElement.className).toContain('text-gray-500');
  });

  it('leaves a tone-less card\'s own pre-colored icon alone', () => {
    render(<StatCard label="Active" value={2} icon={<svg data-testid="icon" className="text-port-accent" />} compact />);
    const wrapper = screen.getByTestId('icon').parentElement;
    expect(wrapper.className).not.toContain('text-gray-500');
    expect(wrapper.className).toContain('shrink-0');
  });
});
