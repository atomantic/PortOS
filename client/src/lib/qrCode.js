/**
 * QR Code encoder (ISO/IEC 18004, byte mode, versions 1–40) with an SVG
 * renderer. Pure JavaScript, no dependencies. Follows the reference
 * structure of Nayuki's QR Code generator (MIT): data codewords, Reed–Solomon
 * ECC per block, interleave, zigzag placement, then the lowest-penalty mask.
 */

/** Error correction level → the 2-bit value written in the format bits. */
export const QR_ERROR_LEVEL = Object.freeze({
  L: 1, // 7% recovery
  M: 0, // 15% recovery
  Q: 3, // 25% recovery
  H: 2, // 30% recovery
});

const LEVEL_ORDER = ['L', 'M', 'Q', 'H'];

// Indexed [level][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const bit = (value, i) => ((value >>> i) & 1) !== 0;

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver, lvl) => Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[lvl][ver] * NUM_ERROR_CORRECTION_BLOCKS[lvl][ver];

// GF(2^8) with the QR polynomial 0x11D.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];

function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    for (let i = 0; i + 11 <= size; i++) {
      for (const pattern of FINDER_LIKE) {
        if (pattern.every((v, k) => get(i + k) === (v === 1))) score += 40;
      }
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x + 1 < size && y + 1 < size) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Encode `text` (UTF-8, byte mode) as a QR Code.
 * @param {string} text
 * @param {object} [options]
 * @param {'L'|'M'|'Q'|'H'} [options.ecc='M'] - lowest error correction level; raised when it fits the same version
 * @returns {{ version: number, ecc: string, mask: number, size: number, modules: boolean[][] }} modules[row][col], true = dark
 */
export function encodeQr(text, { ecc = 'M' } = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text ?? '')));
  let lvl = Math.max(0, LEVEL_ORDER.indexOf(ecc));
  const bitsNeeded = (ver) => 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
  let ver = 1;
  while (ver <= 40 && bitsNeeded(ver) > dataCodewords(ver, lvl) * 8) ver++;
  if (ver > 40) throw new Error(`Text is too long for a QR code (${bytes.length} bytes)`);
  while (lvl < 3 && bitsNeeded(ver) <= dataCodewords(ver, lvl + 1) * 8) lvl++;

  // Data bits: byte mode indicator, count, payload, terminator, pad bytes.
  const capacity = dataCodewords(ver, lvl) * 8;
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0x4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  // Split into blocks, add ECC, interleave.
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[lvl][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[lvl][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]);
    });
  }

  // Function patterns.
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (mask) => {
    const value = (QR_ERROR_LEVEL[LEVEL_ORDER[lvl]] << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(fmt, i));
    set(8, 7, bit(fmt, 6));
    set(8, 8, bit(fmt, 7));
    set(7, 8, bit(fmt, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(fmt, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(fmt, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(fmt, i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserves the format area before data placement
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const verBits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(verBits, i));
      set(b, a, bit(verBits, i));
    }
  }

  // Zigzag data placement.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(modules);
    if (score < bestScore) { best = mask; bestScore = score; }
    applyMask(mask); // XOR again undoes it
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, ecc: LEVEL_ORDER[lvl], mask: best, size, modules };
}

/**
 * Generate an SVG string of a QR Code for `text`.
 * @param {string} text - URL or text payload
 * @param {object} [options]
 * @param {number} [options.size=240] - width & height in px
 * @param {string} [options.bgColor='#ffffff'] - background color
 * @param {string} [options.fgColor='#000000'] - foreground color
 * @param {number} [options.margin=4] - quiet zone in modules (the standard asks for 4)
 * @param {'L'|'M'|'Q'|'H'} [options.ecc='M'] - error correction level
 * @returns {string} SVG markup
 */
export function generateQrCodeSvg(text, {
  size = 240,
  bgColor = '#ffffff',
  fgColor = '#000000',
  margin = 4,
  ecc = 'M',
} = {}) {
  const { size: count, modules } = encodeQr(text || '', { ecc });
  const total = count + margin * 2;
  // One path in module units; the viewBox scales it, so edges stay crisp at any size.
  let d = '';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) if (modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges">`,
    `<rect width="${total}" height="${total}" fill="${bgColor}"/>`,
    `<path d="${d}" fill="${fgColor}"/>`,
    '</svg>',
  ].join('');
}
