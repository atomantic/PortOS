import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import HtmlPreviewFrame from './HtmlPreviewFrame';

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 });
});

describe('HtmlPreviewFrame', () => {
  it('renders the page in a script-only sandbox with the network blocked, never in the app origin', () => {
    const page = '<!doctype html><html><head></head><body><script>run()</script></body></html>';
    render(<HtmlPreviewFrame html={page} title="Example page" />);
    const frame = screen.getByTitle('Example page');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame.getAttribute('srcdoc')).toContain('<script>run()</script>');
  });

  it('says so when no HTML came back instead of showing a blank frame', () => {
    render(<HtmlPreviewFrame html="" title="Empty page" />);
    expect(screen.getByText('No HTML came back for this page')).toBeInTheDocument();
    expect(screen.queryByTitle('Empty page')).not.toBeInTheDocument();
  });

  it('opens a full-size view of the same page', () => {
    render(<HtmlPreviewFrame html="<html><head></head><body>hi</body></html>" title="Example page" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Example page full size' }));
    const full = screen.getByTitle('Example page (full size)');
    expect(full.getAttribute('sandbox')).toBe('allow-scripts');
  });
});
