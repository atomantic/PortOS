import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticExportNames } from './staticExportSurface.js';

// The guards that call this used to read `Object.keys(await import(file))`; the
// two must agree for every export form, so each form is compared against a real import.
describe('staticExportNames', () => {
  let dir;
  const write = (name, src) => { writeFileSync(join(dir, name), src); return join(dir, name); };

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'export-surface-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('matches the runtime namespace for every export form', async () => {
    write('leaf.js', 'export const leaf = 1;\nexport default function noop() {}\n');
    write('other.js', 'export const other = 2;\n');
    const entry = write('barrel.js', [
      'export const { a, b: [c], ...rest } = { a: 1, b: [2], d: 4 };',
      'export async function load() {}',
      'export class Thing {}',
      'export { other as renamed } from "./other.js";',
      'export * from "./leaf.js";',
      'export * as ns from "./other.js";',
      'const local = 1;',
      'export { local as "string name" };',
      'export default 42;',
      '',
    ].join('\n'));
    expect(staticExportNames(entry)).toEqual(Object.keys(await import(entry)).sort());
  });

  it('refuses a star re-export it cannot follow', () => {
    const entry = write('pkg.js', 'export * from "some-package";\n');
    expect(() => staticExportNames(entry)).toThrow(/some-package/);
  });
});
