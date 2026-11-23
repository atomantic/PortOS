import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import PlaygroundOutput, { parseSegments } from './PlaygroundOutput';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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
    const markup = '<style>p { color: blue; }</style><p>hello</p><script>document.title = "Hi";</script>';
    const { getByText, getByTitle, queryByTitle } = render(
      <PlaygroundOutput text={['```html', markup, '```'].join('\n')} />,
    );
    // Preview toggle present for html-like blocks
    const preview = getByText('Preview');
    expect(preview).toBeTruthy();
    // Defaults to code view — no iframe until toggled
    expect(queryByTitle('HTML preview')).toBeNull();
    fireEvent.click(preview);
    const iframe = getByTitle('HTML preview');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    const srcDoc = iframe.getAttribute('srcdoc');
    const csp = srcDoc.match(/^<!doctype html><head><meta http-equiv="Content-Security-Policy" content="([^"]+)"><\/head>/)?.[1];
    expect(csp?.split('; ')).toEqual(expect.arrayContaining([
      "default-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data: blob:',
    ]));
    expect(srcDoc.endsWith(markup)).toBe(true);
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

describe('code copying', () => {
  it('reports success only after the code reaches the clipboard', async () => {
    let finishWrite;
    const writeText = vi.fn(() => new Promise(resolve => { finishWrite = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { getByTitle, queryByText } = render(<PlaygroundOutput text={'```js\nconst answer = 42;\n```'} />);
    fireEvent.click(getByTitle('Copy code'));
    expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    expect(queryByText('Copied')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    finishWrite();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied code'));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('reports a denied copy without a false Copied indicator', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { getByTitle, queryByText } = render(<PlaygroundOutput text={'```js\nconst answer = 42;\n```'} />);
    fireEvent.click(getByTitle('Copy code'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Copy failed'));
    expect(queryByText('Copied')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
