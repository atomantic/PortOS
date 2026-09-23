import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/ImageGen.jsx'), 'utf8');
const componentStart = source.indexOf('export default function ImageGen() {');
const componentEnd = source.lastIndexOf('\n}');
const body = source.slice(source.indexOf('\n', componentStart) + 1, componentEnd);

describe('ImageGen page composition', () => {
  it('keeps the default component body under 100 lines', () => {
    expect(componentStart).toBeGreaterThanOrEqual(0);
    expect(componentEnd).toBeGreaterThan(componentStart);
    expect(body.split('\n').length).toBeLessThan(100);
  });
});
