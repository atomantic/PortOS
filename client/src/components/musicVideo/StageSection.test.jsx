import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StageSection from './StageSection.jsx';

// The folded autopilot and approvals sections compute `defaultOpen` from live
// project state; a change in that state may unfold a section but must never
// fold one the director is working in.
describe('StageSection', () => {
  const section = (defaultOpen) => <StageSection id="example-section" title="Example" defaultOpen={defaultOpen}><p>Body</p></StageSection>;

  it('stays open when defaultOpen turns false, and unfolds when it turns true', () => {
    const { container, rerender } = render(section(true));
    const details = container.querySelector('details');
    expect(details.open).toBe(true);
    rerender(section(false));
    expect(details.open).toBe(true);

    details.open = false;
    rerender(section(false));
    expect(details.open).toBe(false);
    rerender(section(true));
    expect(details.open).toBe(true);
  });

  it('starts folded when defaultOpen is false', () => {
    const { container } = render(section(false));
    expect(container.querySelector('details').open).toBe(false);
  });

  it('keeps a long disclosure title readable and keyboard focus stable when live context changes', async () => {
    const user = userEvent.setup();
    const title = 'Dependency changes and repair';
    const panel = (summary, defaultOpen = false) => <StageSection title={title} summary={summary} defaultOpen={defaultOpen}><p>Review evidence</p></StageSection>;
    const { container, rerender } = render(panel('No repairs pending'));
    const details = container.querySelector('details');
    const disclosure = details.querySelector('summary');
    await user.tab();
    expect(disclosure).toHaveFocus();
    expect(screen.getByText(title)).toBeVisible();

    rerender(panel('An updated dependency needs review', true));
    expect(details.open).toBe(true);
    expect(disclosure).toHaveFocus();
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText('Review evidence')).toBeVisible();
    rerender(panel('No repairs pending'));
    expect(details.open).toBe(true);
    expect(disclosure).toHaveFocus();
  });
});
