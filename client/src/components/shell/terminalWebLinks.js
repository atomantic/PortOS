/*
 * URL matching and wrapped-line heuristics adapted from @xterm/addon-web-links.
 * Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

// Keep the add-on's treatment of delimiters, trailing punctuation, and IPv6 brackets.
const WEB_URL = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
const WRAP_CONTEXT_LIMIT = 2048;

function isWebUrl(text) {
  try {
    const { protocol, username, password, host } = new URL(text);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    let authority = host;
    if (username) authority = (password ? username + ':' + password : username) + '@' + host;
    return text.toLowerCase().startsWith((protocol + '//' + authority).toLowerCase());
  } catch {
    return false;
  }
}

function wrappedRows(buffer, y) {
  const line = buffer.getLine(y - 1);
  if (!line) return [];
  const current = line.translateToString(true);
  const rows = [];
  // Use whole trimmed rows, stopping expansion at a whitespace boundary or
  // after the context budget in each direction, as the add-on did.
  if (line.isWrapped && !current.startsWith(' ')) {
    let length = 0;
    for (let row = y - 1; length < WRAP_CONTEXT_LIMIT; row--) {
      const previous = buffer.getLine(row - 1);
      if (!previous) break;
      const text = previous.translateToString(true);
      rows.push({ y: row, text });
      length += text.length;
      if (!previous.isWrapped || text.includes(' ')) break;
    }
    rows.reverse();
  }
  rows.push({ y, text: current });

  let length = 0;
  for (let row = y + 1; length < WRAP_CONTEXT_LIMIT; row++) {
    const next = buffer.getLine(row - 1);
    if (!next?.isWrapped) break;
    const text = next.translateToString(true);
    rows.push({ y: row, text });
    length += text.length;
    if (text.includes(' ')) break;
  }
  return rows;
}

function bufferPosition(buffer, rows, offset, end = false) {
  for (const { y, text } of rows) {
    if (offset >= text.length) {
      offset -= text.length;
      continue;
    }
    const line = buffer.getLine(y - 1);
    const cell = buffer.getNullCell();
    // The regex counts UTF-16 units. xterm ranges count cells, with inclusive
    // endpoints, including the trailing column of a wide cell at the end.
    for (let column = 0; column < line.length;) {
      line.getCell(column, cell);
      const width = cell.getWidth() || 1;
      offset -= cell.getChars().length || 1;
      if (offset < 0) return { x: column + (end ? width : 1), y };
      column += width;
    }
    return undefined;
  }
}

export function registerTerminalWebLinks(terminal, openWindow = () => window.open()) {
  const activate = (_event, text) => {
    const popup = openWindow();
    if (!popup) {
      console.warn('Opening link blocked as opener could not be cleared');
      return;
    }
    popup.opener = null;
    popup.location.href = text;
  };

  return terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = terminal.buffer.active;
      const rows = wrappedRows(buffer, y);
      const content = rows.map(({ text }) => text).join('');
      const links = [];
      for (const match of content.matchAll(WEB_URL)) {
        const [text] = match;
        if (!isWebUrl(text)) continue;
        const start = bufferPosition(buffer, rows, match.index);
        const end = bufferPosition(buffer, rows, match.index + text.length - 1, true);
        if (start && end && start.y <= y && end.y >= y) {
          links.push({ text, range: { start, end }, activate });
        }
      }
      callback(links);
    },
  });
}
