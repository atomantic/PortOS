import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitTerminal } from './terminalFit.js';

const makeTerminal = ({
  parentWidth = 820,
  parentHeight = 500,
  padding = { top: 5, bottom: 5, left: 10, right: 20 },
  cell = { width: 10, height: 20 },
  scrollback = 5000,
  overviewRulerWidth = 18,
  cols = 80,
  rows = 24,
} = {}) => {
  const parent = document.createElement('div');
  const element = document.createElement('div');
  parent.appendChild(element);
  document.body.appendChild(parent);
  const styles = new Map([
    [parent, { height: parentHeight, width: parentWidth }],
    [element, {
      'padding-top': padding.top,
      'padding-bottom': padding.bottom,
      'padding-left': padding.left,
      'padding-right': padding.right,
    }],
  ]);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((target) => ({
    getPropertyValue: (property) => `${styles.get(target)?.[property] ?? 0}px`,
  }));

  const terminal = {
    element,
    options: { scrollback, overviewRuler: { width: overviewRulerWidth } },
    cols,
    rows,
    _core: {
      _renderService: {
        dimensions: { css: { cell } },
        clear: vi.fn(),
      },
    },
    resize: vi.fn((nextCols, nextRows) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    }),
  };
  return terminal;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('fitTerminal', () => {
  it('fits to the parent while accounting for padding and the overview ruler', () => {
    const terminal = makeTerminal();

    fitTerminal(terminal);

    expect(terminal.resize).toHaveBeenCalledWith(77, 24);
    expect(terminal._core._renderService.clear).toHaveBeenCalledOnce();
  });

  it('omits the scrollbar allowance when scrollback is disabled', () => {
    const terminal = makeTerminal({
      parentWidth: 35,
      parentHeight: 21,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      scrollback: 0,
      cols: 80,
      rows: 24,
    });

    fitTerminal(terminal);

    expect(terminal.resize).toHaveBeenCalledWith(3, 1);
  });

  it('clamps dimensions to the minimum geometry', () => {
    const terminal = makeTerminal({
      parentWidth: 1,
      parentHeight: 1,
      padding: { top: 20, bottom: 20, left: 20, right: 20 },
      cols: 80,
      rows: 24,
    });

    fitTerminal(terminal);

    expect(terminal.resize).toHaveBeenCalledWith(2, 1);
  });

  it('does not invalidate or resize when the geometry is unchanged', () => {
    const terminal = makeTerminal({ cols: 77, rows: 24 });

    fitTerminal(terminal);

    expect(terminal.resize).not.toHaveBeenCalled();
    expect(terminal._core._renderService.clear).not.toHaveBeenCalled();
  });

  it('is inert before the terminal has a parent or usable cell metrics', () => {
    const terminal = makeTerminal({ cell: { width: 0, height: 20 } });
    terminal.element.parentElement.removeChild(terminal.element);

    fitTerminal(terminal);

    expect(terminal.resize).not.toHaveBeenCalled();
    expect(terminal._core._renderService.clear).not.toHaveBeenCalled();
  });
});
