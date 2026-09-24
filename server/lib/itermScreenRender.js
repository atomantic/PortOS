// Render one iTerm2 get-buffer snapshot (decoded by lib/itermMessages.js) into
// a single ANSI string that repaints an xterm.js viewer in place (#8114).
//
// Frame layout: hide the cursor and home, then for each screen row
// `CSI r;1H` + SGR runs + text + `CSI 0m CSI K`, then park the cursor at
// iTerm's cursor position and show it again. Rows past the snapshot are
// cleared, so a shrinking screen leaves no stale text behind.
//
// iTerm reports the cursor in ABSOLUTE scrollback coordinates, so its row is
// offset by the first visible line number before use. Cells are rebuilt from
// the per-cell code-point run lengths so combined and wide characters (CJK,
// emoji) keep the following text column-aligned; a cell with zero code points
// (the right half of a wide character) emits nothing.

const ESC = '\x1b[';

const sgrColor = (base, rgb, standard) => {
  if (rgb) return `${base + 8};2;${rgb.red ?? 0};${rgb.green ?? 0};${rgb.blue ?? 0}`;
  if (standard !== undefined) return `${base + 8};5;${standard}`;
  return `${base + 9}`;
};

/** SGR parameter string for one decoded cell style (`undefined` = default). */
export const itermStyleToSgr = (style) => {
  const params = ['0'];
  if (!style) return params.join(';');
  if (style.bold) params.push('1');
  if (style.faint) params.push('2');
  if (style.italic) params.push('3');
  if (style.underline) params.push('4');
  if (style.inverse) params.push('7');
  if (style.invisible) params.push('8');
  if (style.strikethrough) params.push('9');
  const fg = sgrColor(30, style.fgRgb, style.fgStandard);
  const bg = sgrColor(40, style.bgRgb, style.bgStandard);
  if (fg !== '39') params.push(fg);
  if (bg !== '49') params.push(bg);
  return params.join(';');
};

// Replace C0/C1 controls and DEL so screen text can never smuggle an escape
// sequence into the viewer's terminal.
const safeText = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

// Expand run-length encoded entries (`repeats`, default 1) lazily.
const runLengthCursor = (runs) => {
  let runIdx = 0;
  let used = 0;
  return () => {
    while (runIdx < runs.length) {
      const run = runs[runIdx];
      const repeats = Math.max(1, run?.repeats ?? 1);
      if (used < repeats) {
        used += 1;
        return run;
      }
      runIdx += 1;
      used = 0;
    }
    return undefined;
  };
};

const renderLine = (line, cols) => {
  const codePoints = Array.from(line?.text ?? '');
  const cells = line?.codePointsPerCell ?? [];
  const nextCell = runLengthCursor(cells);
  const nextStyle = runLengthCursor(line?.style ?? []);
  let out = '';
  let lastSgr = null;
  let cp = 0;
  for (let col = 0; col < cols && cp < codePoints.length; col += 1) {
    const cell = cells.length > 0 ? nextCell() : null;
    if (cells.length > 0 && !cell) break;
    const width = cell ? (cell.numCodePoints ?? 1) : 1;
    const sgr = itermStyleToSgr(nextStyle());
    const text = codePoints.slice(cp, cp + width).join('');
    cp += width;
    if (width === 0) continue;
    if (sgr !== lastSgr) {
      out += `${ESC}${sgr}m`;
      lastSgr = sgr;
    }
    out += safeText(text);
  }
  return out;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {object} frame
 * @param {Array} frame.lines - decoded LineContents, top row first
 * @param {{x:number,y:number}} [frame.cursor] - absolute (scrollback) cursor
 * @param {number} [frame.firstVisibleLine] - absolute line number of row 1
 * @param {number} frame.cols
 * @param {number} frame.rows
 * @returns {string}
 */
export const renderItermFrame = ({ lines = [], cursor, firstVisibleLine = 0, cols, rows }) => {
  const width = Math.max(1, cols || 0);
  const height = Math.max(1, rows || lines.length || 1);
  let out = `${ESC}?25l${ESC}H`;
  for (let row = 0; row < height; row += 1) {
    out += `${ESC}${row + 1};1H${renderLine(lines[row], width)}${ESC}0m${ESC}K`;
  }
  const cursorRow = cursor ? clamp((cursor.y ?? 0) - firstVisibleLine + 1, 1, height) : 1;
  const cursorCol = cursor ? clamp((cursor.x ?? 0) + 1, 1, width) : 1;
  out += `${ESC}${cursorRow};${cursorCol}H`;
  if (cursor) out += `${ESC}?25h`;
  return out;
};

/**
 * Seed an xterm scrollback buffer with the historical rows before painting the
 * live screen. The extra line feeds scroll those rows above the viewport so
 * the following frame can occupy the current screen without losing history.
 */
export const renderItermSnapshot = ({
  lines = [], cursor, firstVisibleLine = 0, rangeStartLine, cols, rows,
}) => {
  const width = Math.max(1, cols || 0);
  const height = Math.max(1, rows || lines.length || 1);
  const firstReturnedLine = Number.isFinite(rangeStartLine)
    ? rangeStartLine
    : Math.max(0, firstVisibleLine - Math.max(0, lines.length - height));
  const historyCount = clamp(firstVisibleLine - firstReturnedLine, 0, lines.length);
  const historyLines = lines.slice(0, historyCount);
  const screenLines = lines.slice(historyCount);

  let history = '';
  if (historyLines.length > 0) {
    history = `${ESC}?25l${ESC}H`;
    for (const line of historyLines) {
      history += `${renderLine(line, width)}${ESC}0m${ESC}K\r\n`;
    }
    history += '\r\n'.repeat(height - 1);
  }

  return history + renderItermFrame({
    lines: screenLines,
    cursor,
    firstVisibleLine,
    cols: width,
    rows: height,
  });
};
