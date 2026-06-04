import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import PlaygroundOutput, { parseSegments } from './PlaygroundOutput';

describe('parseSegments', () => {
  it('splits prose and fenced code into ordered segments with the language captured', () => {
    const segments = parseSegments('Here you go:\n```html\n<h1>Hi</h1>\n```\nDone.');
    expect(segments.map((s) => s.type)).toEqual(['text', 'code', 'text']);
    expect(segments[1]).toMatchObject({ lang: 'html', code: '<h1>Hi</h1>', closed: true });
    expect(segments[0].content).toBe('Here you go:');
    expect(segments[2].content).toBe('Done.');
  });

  it('marks an unterminated fence (still streaming) as not closed and consumes the rest as code', () => {
    const segments = parseSegments('```js\nconst a = 1;\nconst b = 2;');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'code', lang: 'js', closed: false });
    expect(segments[0].code).toBe('const a = 1;\nconst b = 2;');
  });

  it('returns a single text segment when there is no code', () => {
    const segments = parseSegments('just plain text');
    expect(segments).toEqual([{ type: 'text', content: 'just plain text' }]);
  });

  it('handles empty input', () => {
    expect(parseSegments('')).toEqual([]);
    expect(parseSegments(null)).toEqual([]);
  });
});

describe('PlaygroundOutput rendering', () => {
  it('renders an HTML code block with a Preview toggle and a sandboxed iframe', () => {
    const { container, getByText, queryByTitle } = render(
      <PlaygroundOutput text={'```html\n<p>hello</p>\n```'} />,
    );
    // Preview toggle present for html-like blocks
    const preview = getByText('Preview');
    expect(preview).toBeTruthy();
    // Defaults to code view — no iframe until toggled
    expect(queryByTitle('HTML preview')).toBeNull();
    fireEvent.click(preview);
    const iframe = container.querySelector('iframe[title="HTML preview"]');
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('srcdoc')).toBe('<p>hello</p>');
  });

  it('does NOT offer a Preview toggle for a non-HTML language', () => {
    const { queryByText } = render(<PlaygroundOutput text={'```python\nprint(1)\n```'} />);
    expect(queryByText('Preview')).toBeNull();
  });

  it('offers Preview for a bare fence whose body sniffs as HTML', () => {
    const { getByText } = render(<PlaygroundOutput text={'```\n<!doctype html><html></html>\n```'} />);
    expect(getByText('Preview')).toBeTruthy();
  });
});
