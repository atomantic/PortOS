import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownOutput from './MarkdownOutput';

it('keeps intraword underscores literal instead of consuming them as emphasis', () => {
  render(<MarkdownOutput content="QUALITY_AUDIT_JSON: done" />);
  expect(screen.getByText('QUALITY_AUDIT_JSON: done')).toBeInTheDocument();
});

it('still renders a genuine word-boundary _emphasis_ span as italic', () => {
  render(<MarkdownOutput content="this is _important_ text" />);
  const em = screen.getByText('important');
  expect(em.tagName).toBe('EM');
  expect(screen.getByText(/this is/)).toBeInTheDocument();
});

// MarkdownOutput renders inside cards, drawers and tab panels — never as the
// page's own outline — so a `#` line in stored model output must not emit a
// real `h1`/`h2` (#7264). Source levels shift into a band under `baseLevel`
// (default 3) while H_STYLES keeps indexing the SOURCE `#` count, so only the
// tag name moves; the in-card visual hierarchy is unchanged.

const SOURCE_STYLES = {
  1: 'text-base font-bold text-white mt-3 mb-1',
  2: 'text-sm font-bold text-white mt-3 mb-1',
  3: 'text-xs font-semibold text-port-accent mt-2 mb-1',
  4: 'text-xs font-semibold text-gray-300 mt-2 mb-0.5',
};

describe('MarkdownOutput heading levels', () => {
  it('shifts # to h3 at the default baseLevel', () => {
    render(<MarkdownOutput content={'# Title'} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'Title' });
    expect(heading.tagName).toBe('H3');
  });

  it('shifts ## and ### to h4 and h5', () => {
    render(<MarkdownOutput content={'## Sub\n\n### Detail'} />);
    expect(screen.getByRole('heading', { level: 4, name: 'Sub' }).tagName).toBe('H4');
    expect(screen.getByRole('heading', { level: 5, name: 'Detail' }).tagName).toBe('H5');
  });

  it('shifts #### to h6', () => {
    render(<MarkdownOutput content={'#### Deep'} />);
    expect(screen.getByRole('heading', { level: 6, name: 'Deep' }).tagName).toBe('H6');
  });

  it('clamps ##### and ###### at h6 instead of emitting an invalid tag', () => {
    const { container } = render(<MarkdownOutput content={'##### Five\n\n###### Six'} />);
    expect(screen.getByRole('heading', { level: 6, name: 'Five' }).tagName).toBe('H6');
    expect(screen.getByRole('heading', { level: 6, name: 'Six' }).tagName).toBe('H6');
    expect(container.querySelector('h7')).toBeNull();
  });

  it('never emits h1 or h2 at the default baseLevel', () => {
    const { container } = render(
      <MarkdownOutput content={'# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F'} />,
    );
    expect(container.querySelector('h1, h2')).toBeNull();
  });

  it('keeps H_STYLES indexed by the source # count, not the emitted tag', () => {
    render(<MarkdownOutput content={'# One\n\n## Two\n\n### Three\n\n#### Four'} />);
    expect(screen.getByRole('heading', { level: 3, name: 'One' }).className).toBe(SOURCE_STYLES[1]);
    expect(screen.getByRole('heading', { level: 4, name: 'Two' }).className).toBe(SOURCE_STYLES[2]);
    expect(screen.getByRole('heading', { level: 5, name: 'Three' }).className).toBe(SOURCE_STYLES[3]);
    expect(screen.getByRole('heading', { level: 6, name: 'Four' }).className).toBe(SOURCE_STYLES[4]);
  });

  it('shifts the whole band when a consumer passes baseLevel', () => {
    render(<MarkdownOutput content={'# One\n\n## Two\n\n### Three'} baseLevel={4} />);
    expect(screen.getByRole('heading', { level: 4, name: 'One' }).tagName).toBe('H4');
    expect(screen.getByRole('heading', { level: 5, name: 'Two' }).tagName).toBe('H5');
    // baseLevel 4 + source 3 - 1 = 6 — already at the ceiling.
    expect(screen.getByRole('heading', { level: 6, name: 'Three' }).tagName).toBe('H6');
  });
});
