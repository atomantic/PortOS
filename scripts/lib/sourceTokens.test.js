import { describe, expect, it } from 'vitest';
import { moduleImports, tokenize } from './sourceTokens.js';

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
    expect(moduleImports(source)).toEqual({ statics: [], deferred: [], mocked: [], computed: false });
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
      deferred: ['./lazy.js', './template.js', './expression.js'], mocked: [], computed: false,
    });
  });

  it('lists literal vi.mock-family targets without counting them as loads', () => {
    const source = [
      'vi.mock("./mocked.js", () => ({})); vi.doMock(`./doMocked.js`); vi.unmock("./unmocked.js");',
      'const real = await vi.importActual("./actual.js"); const fake = await vi.importMock("./fake.js");',
      'vi.mock(modulePath); vi.spyOn(module, "mock"); other.vi.mock("./member.js"); // vi.mock("./comment.js")',
      `const fixture = "vi.mock('./quoted.js')";`,
    ].join('\n');
    expect(moduleImports(source)).toEqual({
      statics: [], deferred: [], computed: false,
      mocked: ['./mocked.js', './doMocked.js', './unmocked.js', './actual.js', './fake.js'],
    });
  });

  it.each([
    'import(modulePath)', 'import("./" + modulePath)', 'import(`./${modulePath}`)',
    '`text ${import(modulePath)}`', 'import(("./wrapped.js"))',
  ])('retains uncertainty for the executable expression %s', (source) => {
    expect(moduleImports(source).computed).toBe(true);
  });

  it('keeps executable JSX expressions outside quoted child prose and attribute strings', () => {
    const source = `<div // A child's "import(unknown)" prose has { and > here.
      title="import(unknown)">"{load(import('./child.js'))}"<span>{import('./nested.js')}</span>{
      <Other value={import('./attribute.js')} />
    }</div>`;
    expect(moduleImports(source)).toEqual({ statics: [],
      deferred: ['./child.js', './nested.js', './attribute.js'], mocked: [], computed: false });
    expect(moduleImports('const view = <>"{import(modulePath)}"</>').computed).toBe(true);
    expect(() => moduleImports('const view = <Unknown>')).toThrow(/JSX/);
  });

  it('distinguishes TypeScript assertions and TSX generic arrows from JSX', () => {
    const ts = 'const identity = <T>(value: T) => value; const asserted = <Thing>value; import("./typed.js");';
    expect(moduleImports(ts, { jsx: false })).toEqual({ statics: [], deferred: ['./typed.js'], mocked: [], computed: false });
    const tsx = 'const identity = <T,>(value: T) => import("./generic.js"); const view = <div>{import("./jsx.js")}</div>;';
    expect(moduleImports(tsx)).toEqual({ statics: [], deferred: ['./generic.js', './jsx.js'], mocked: [], computed: false });
  });

  it('does not treat division as a regex and hide an executable import', () => {
    for (const value of ['value', 'value++', 'value--', 'call()', 'value.catch()', 'value?.catch()', 'value.with()', 'value.if()', 'rates.of', 'rates?.of', 'rates.return', 'rates.await']) {
      expect(moduleImports(`const ratio = ${value} / import("./real.js") / divisor;`).deferred).toEqual(['./real.js']);
    }
  });
});

describe('string tokens', () => {
  // The test memo resolves a path from literal text (scripts/lib/testMemo.js): an escape left undecoded
  // names a different file, so `'\\x2e\\x2e/x'` would be read as a name instead of a climb.
  it('decodes hex, unicode and line-continuation escapes in strings and templates', () => {
    const values = (source) => tokenize(source).filter((token) => token.t === 's' || token.t === 'tpl').map((token) => token.v ?? token.quasis.join('|'));
    expect(values("const a = '\\x2e\\x2e/\\u0066\\u{30}.json';")).toEqual(['../f0.json']);
    expect(values('const b = `\\x2e\\u002e/${x}\\u{1F600}`;')).toEqual(['../|\u{1F600}']);
    expect(values("const c = 'a\\\nb\\n\\t\\\\';")).toEqual(['ab\n\t\\']);
    // Not an escape sequence: the characters stand for themselves.
    expect(values("const d = '\\xZZ \\u12 \\q';")).toEqual(['xZZ u12 q']);
  });
});
