import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #16559: keep new schemas out of the catch-all. It declares its own schemas only (#16803).
describe('validation.js stays a shrinking catch-all', () => {
  const barrelPath = fileURLToPath(new URL('./validation.js', import.meta.url));
  const barrelSrc = readFileSync(barrelPath, 'utf8');
  const ownExportCeiling = 266;
  const ownExportNames = (src) => {
    const names = new Set([...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((match) => match[1]));
    for (const [, list] of src.matchAll(/^export\s*\{([^}]*)\}\s*(?:;|$)/gm)) {
      for (const part of list.split(',').map((name) => name.trim()).filter(Boolean)) {
        names.add(part.split(/\s+as\s+/).pop().trim());
      }
    }
    return names;
  };
  const ownNames = ownExportNames(barrelSrc);

  it(`declares at most ${ownExportCeiling} own exports`, () => {
    expect(ownNames.size, 'Put new schemas in their domain validation modules and ratchet the ceiling down after moving exports.')
      .toBeLessThanOrEqual(ownExportCeiling);
  });

  it('counts only own exports', async () => {
    const validation = await import('./validation.js');
    for (const name of ownNames) expect(validation).toHaveProperty(name);
    expect(ownNames.has('appIconQuerySchema')).toBe(true);
    expect(ownNames.has('optionalBooleanMap')).toBe(true);
    expect(ownNames.has('validateRequest')).toBe(false);
    expect(ownExportNames(`${barrelSrc}\nexport const plantedSchema = z.string();\n`).size).toBe(ownNames.size + 1);
  });

  it('re-exports nothing from other modules', () => {
    // #16803: a re-export gives every importer of a domain file the barrel's whole audience.
    const code = barrelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/^\s*export\s*\*/m);
    expect(code).not.toMatch(/^\s*export\s*(?:\{[^}]*\}|\*\s+as\s+\w+)\s*from\b/m);
  });
});
