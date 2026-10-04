import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
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
});
