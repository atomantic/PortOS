import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SatPhoneCaption from './SatPhoneCaption';

// happy-dom does no layout, so the box measures as tall as its text says.
const LINE_PX = 15;
const COLLAPSED_PX = 44;
const descriptors = {};

beforeEach(() => {
  for (const key of ['scrollHeight', 'clientHeight']) {
    descriptors[key] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return Math.ceil((this.textContent?.length || 0) / 40) * LINE_PX; },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.dataset.expanded === 'true' ? this.scrollHeight : Math.min(this.scrollHeight, COLLAPSED_PX); },
  });
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else delete HTMLElement.prototype[key];
  }
});

const LONG = 'I do not have a specific version number to share, but I am up and running and happy to help with anything you need today.';

describe('SatPhoneCaption', () => {
  it('offers no toggle for a caption that fits', () => {
    render(<SatPhoneCaption caption="Hello there." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the newest words in view and expands a long reply so none of it is cut off', () => {
    const { container, rerender } = render(<SatPhoneCaption caption="I do not have" />);
    rerender(<SatPhoneCaption caption={LONG} />);
    const box = container.querySelector('[data-expanded]');
    expect(box.scrollTop).toBe(box.scrollHeight);

    fireEvent.click(screen.getByRole('button', { name: 'Show the whole caption' }));
    expect(box).toHaveAttribute('data-expanded', 'true');
    expect(box).toHaveTextContent(LONG);

    // The next utterance starts collapsed again.
    rerender(<SatPhoneCaption caption="What time is it?" />);
    expect(box).toHaveAttribute('data-expanded', 'false');
  });
});
