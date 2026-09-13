import { it, expect } from 'vitest';
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
