import { describe, expect, it } from 'vitest';
import { moduleImports } from './sourceTokens.js';

describe('no-install module import extraction', () => {
  it('ignores comment prose, quoted fixtures, template text and regex source', () => {
    const source = [
      '// import (#2895)',
      '/* import (#1945); export { value } from "./comment.js"; */',
      'const quoted = "import(unknown)";',
      'const fixture = `import value from "./ProbeGood";\nexport * from "./ProbeBarrel"; import(unknown)`;',
      'const pattern = /import\\s*\\(unknown\\)/g;',
      'const other = /export .* from "ghost"/;',
      'if (ready) /import(unknown)/.test(text);',
      'object.import(unknown); object?.import(unknown);',
    ].join('\n');
    expect(moduleImports(source)).toEqual({ statics: [], deferred: [], computed: false });
  });

  it('finds real declarations, re-exports, deferred literals and template expressions', () => {
    const source = [
      'import "./side.js"; import { value } from "./static.js";',
      'export { value } from "./bridge.js"; export * as all from "./all.js";',
      'const one = import(/* comment */ "./lazy.js", { with: { type: "json" } });',
      'const two = import(`./template.js`);',
      'const text = `fixture import(unknown) ${import("./expression.js")}`;',
    ].join('\n');
    expect(moduleImports(source)).toEqual({
      statics: ['./side.js', './static.js', './bridge.js', './all.js'],
      deferred: ['./lazy.js', './template.js', './expression.js'], computed: false,
    });
  });

  it.each([
    'import(modulePath)', 'import("./" + modulePath)', 'import(`./${modulePath}`)',
    '`text ${import(modulePath)}`', 'import(("./wrapped.js"))',
  ])('retains uncertainty for the executable expression %s', (source) => {
    expect(moduleImports(source).computed).toBe(true);
  });

  it('does not treat division as a regex and hide an executable import', () => {
    for (const value of ['value', 'value++', 'value--', 'call()']) {
      expect(moduleImports(`const ratio = ${value} / import("./real.js") / divisor;`).deferred).toEqual(['./real.js']);
    }
  });
});
