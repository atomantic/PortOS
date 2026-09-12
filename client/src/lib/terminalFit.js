const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
const DEFAULT_SCROLLBAR_WIDTH = 14;

const cssPixels = (style, property) => Number.parseInt(style.getPropertyValue(property), 10);

/** Fit an xterm instance to its parent, preserving the addon's sizing contract. */
export const fitTerminal = (terminal) => {
  const element = terminal?.element;
  const parent = element?.parentElement;
  const cell = terminal?._core?._renderService?.dimensions?.css?.cell;
  if (!element || !parent || !(cell?.width > 0) || !(cell?.height > 0)
    || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;

  const scrollbarWidth = terminal.options?.scrollback === 0
    ? 0
    : terminal.options?.overviewRuler?.width || DEFAULT_SCROLLBAR_WIDTH;
  const parentStyle = window.getComputedStyle(parent);
  const elementStyle = window.getComputedStyle(element);
  const parentHeight = cssPixels(parentStyle, 'height');
  const parentWidth = Math.max(0, cssPixels(parentStyle, 'width'));
  const paddingVertical = cssPixels(elementStyle, 'padding-top')
    + cssPixels(elementStyle, 'padding-bottom');
  const paddingHorizontal = cssPixels(elementStyle, 'padding-right')
    + cssPixels(elementStyle, 'padding-left');
  const cols = Math.max(MINIMUM_COLS, Math.floor(
    (parentWidth - paddingHorizontal - scrollbarWidth) / cell.width,
  ));
  const rows = Math.max(MINIMUM_ROWS, Math.floor(
    (parentHeight - paddingVertical) / cell.height,
  ));
  if (Number.isNaN(cols) || Number.isNaN(rows)
    || (terminal.cols === cols && terminal.rows === rows)) return;

  terminal._core?._renderService?.clear?.();
  terminal.resize(cols, rows);
};
