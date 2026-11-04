// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { encodeQr, generateQrCodeSvg } from './qrCode.js';

describe('encodeQr', () => {
  // Cross-checked cell for cell against the npm `qrcode` 1.5.4 encoder (same version, level and
  // mask) and decoded by zxing-cpp; a regression here prints a code phones can't scan.
  it('encodes a link as a standard QR matrix', () => {
    const q = encodeQr('https://youtu.be/AbCdEf12345');
    expect({ version: q.version, ecc: q.ecc, mask: q.mask, size: q.size }).toEqual({ version: 3, ecc: 'Q', mask: 3, size: 29 });
    expect(q.modules.map((row) => row.map((dark) => (dark ? '#' : '.')).join(''))).toEqual([
      '#######..#.#.###...#..#######',
      '#.....#.#..#..##.##.#.#.....#',
      '#.###.#.###..##...###.#.###.#',
      '#.###.#..###...#.#..#.#.###.#',
      '#.###.#..##.##...###..#.###.#',
      '#.....#..#.#..#...###.#.....#',
      '#######.#.#.#.#.#.#.#.#######',
      '.........######.####.........',
      '.###.##..##..#.#....#.....##.',
      '#.#.##....#.#.##..##.####...#',
      '###..###.....#...##...#..###.',
      '#..#...#..##.###.......#....#',
      '#....####....#####...#.#..###',
      '.....#..##.#...#..##..##.##..',
      '..##.##.#..#.##..#########.##',
      '...#.#..###.###..##..##.##..#',
      '..#..##..##.#.######...#.#.##',
      '.....#....#####.#....#.#.#...',
      '#.##.###..#...###.....#.#.#..',
      '..####.##...#....######..##..',
      '.#...######.###.##.#######.#.',
      '........#....##.#.###...##.##',
      '#######...##..#..#.##.#.#.#..',
      '#.....#.#.#.#..##.#.#...#..##',
      '#.###.#....##.##..#.#######..',
      '#.###.#.##.###..#.##....#.##.',
      '#.###.#.##...######.#..#..#.#',
      '#.....#.#..#.##.#.####..##.#.',
      '#######....###.#..#.##.#...#.',
    ]);
  });

  it('grows the version with the payload and refuses one past version 40', () => {
    expect(encodeQr('x'.repeat(300)).version).toBeGreaterThan(10);
    expect(encodeQr('x'.repeat(2953), { ecc: 'L' }).version).toBe(40);
    expect(() => encodeQr('x'.repeat(2954), { ecc: 'L' })).toThrow(/too long/);
  });
});

describe('generateQrCodeSvg', () => {
  it('draws the matrix with a four-module quiet zone at the requested pixel size', () => {
    const svg = generateQrCodeSvg('https://youtu.be/AbCdEf12345', { size: 240 });
    expect(svg).toContain('viewBox="0 0 37 37"');
    expect(svg).toContain('width="240" height="240"');
    expect(svg).toMatch(/<path d="M4 4h1v1h-1z/);
  });
});
