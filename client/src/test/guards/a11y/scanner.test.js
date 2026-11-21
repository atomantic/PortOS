/**
 * Accessibility conventions: the JSX scanner and wrapper recognizer the other guards stand on.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { maskedSourceByFile, virtualSources, openingTagAt, tagIndexOf, forEachTag, forEachOpeningTag, regexEnd, balancedCallAt, matchingBraceEnd, tagBoundaryAt, topLevelOperatorIn, isIconOnlyBody, findButtonBody } from '../../a11yScanCore.js';
import { maskComments, stripHiddenElementContent, stripJsxTags } from '../../a11yScanNames.js';
import { withVirtualSources } from '../../a11yScanWrappers.js';
import { isNamed } from '../../a11yScanRules.js';

describe('a11y conventions: scanner', () => {
  it('derives every remaining lexical fact from the shared tag index (#4343)', () => {
    // A raw `/>` suffix is not proof of a self-closing JSX node: this is an
    // opening component tag whose comment happens to end in `/>`. The icon
    // rule must leave that malformed-but-readable shape out of its match.
    expect(isIconOnlyBody('{on ? <IconA /* note */> : <IconB />}')).toBe(false);
    expect(isIconOnlyBody('{on && <IconA /* note */>}')).toBe(false);

    // `$` is part of the tag spelling everywhere else. Ternary, &&, and a
    // presentational host wrapper must agree instead of each carrying a
    // narrower ad-hoc class.
    expect(isIconOnlyBody('{on ? <Ic$n /> : <IconB />}')).toBe(true);
    expect(isIconOnlyBody('{on && <Ic$n />}')).toBe(true);
    expect(isIconOnlyBody('<spa$n><IconA /></spa$n>')).toBe(true);

    // A nested hidden subtree must remain hidden through its ACTUAL matching
    // close, not only through the first same-named closer a non-greedy regex
    // reaches. A quoted `>` likewise stays inside its opening tag and cannot
    // leak an attribute quote back as rendered label text.
    expect(isNamed('<label htmlFor="x"><span aria-hidden="true"><span>Hidden</span>still hidden</span></label>\n<input id="x" />')).toBe(false);
    expect(isNamed('<label htmlFor="x"><span title=">"></span></label>\n<input id="x" />')).toBe(false);
    expect(isNamed('<label htmlFor="x"><span title=">">Rounds</span></label>\n<input id="x" />')).toBe(true);
    expect(isNamed('<span id="x" aria-hidden={true}>Hidden</span>\n<input aria-labelledby="x" />')).toBe(false);

    // These helpers receive an element BODY, so their first character is JSX
    // text rather than JavaScript. An apostrophe there must not open a fake
    // string and hide the structural tags that follow it.
    const apostropheThenHidden = "don't <span aria-hidden=\"true\">Hidden</span>";
    const hiddenStripped = stripHiddenElementContent(apostropheThenHidden);
    expect(hiddenStripped).not.toContain('Hidden');
    expect(hiddenStripped).not.toContain('<span');
    const tagsStripped = stripJsxTags("don't <span>Visible</span>");
    expect(tagsStripped).toContain("don't");
    expect(tagsStripped).toContain('Visible');
    expect(tagsStripped).not.toContain('<span');
    expect(tagsStripped).not.toContain('</span>');

    // Closing the only tag must also return to the slice's JSX-text context.
    // Otherwise the later apostrophe opens a fake JavaScript string and hides
    // the second tag from both the tag stripper and hidden-content pass.
    const apostropheAfterTag = "Before <span>Visible</span> don't <span>Later</span>";
    const afterCloseTagsStripped = stripJsxTags(apostropheAfterTag);
    expect(afterCloseTagsStripped).not.toContain('<span');
    expect(afterCloseTagsStripped).not.toContain('</span>');
    const visibleThenHidden = "Before <span>Visible</span> don't <span aria-hidden=\"true\">Hidden later</span>";
    expect(stripHiddenElementContent(visibleThenHidden)).not.toContain('Hidden later');

    // An expression can contain a string that looks like a tag. It is still
    // one direct child of FormField, so the clone reaches the real input; only
    // the scanner can distinguish that string from a nested JSX ancestor.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Rounds">${child}</FormField>`;
    expect(isNamed(field('{enabled && "<div>" && <input type="number" />}'))).toBe(true);
    // A Fragment, by contrast, is its own React child. Cloning the Fragment's
    // id does not forward it to the input inside.
    expect(isNamed(field('<><input type="number" /></>'))).toBe(false);
  });

  it('sees a component whose name holds a `$` (#4341)', () => {
    // `relativeImportBindings` admitted `$` and `forEachLocalComponent` did not,
    // so a `Fi$ld` wrapper was invisible from both directions at once and no
    // fixture could witness the disagreement. Now every detector — and the walk,
    // which matches names literally instead of splicing them into a pattern
    // where `$` is an anchor — spells an identifier the same way.
    const wrapper = 'function Fi$ld({ label, children }) {\n  return (<label className="block"><span>{label}</span>{children}</label>);\n}';
    expect(isNamed(`${wrapper}\n<Fi$ld label="Rounds"><select value={v} /></Fi$ld>`, 'select')).toBe(true);
    // …and it is the wrapper's LABEL doing the naming, not its name being seen.
    expect(isNamed(`${wrapper}\n<Fi$ld><select value={v} /></Fi$ld>`, 'select')).toBe(false);
  });

  it('starts a tag after a statement brace, but not after a value (#4341)', () => {
    // Since the walks became scanner-driven, `looksLikeJsxTagStart` is the only
    // thing standing between a wrapper and the registry — the regex walk found
    // the tag either way — so both directions of it need pinning.
    const wrapper = 'function Field({ label, children }) {\n  return (<label>{label}{children}</label>);\n}';
    expect(isNamed(`${wrapper}\n<Field label="Rounds"><select value={v} /></Field>`, 'select')).toBe(true);
    // A `<` after a VALUE is a comparison. Reading it as a tag would open a
    // phantom element that swallows source up to the next `>`, taking every
    // real tag in between out of the scan with it.
    expect([...forEachTag('const ok = size() <limit;')].map((node) => node.name)).toEqual([]);
    // The `}` widening's own risky direction — an object literal rather than a
    // statement — is bounded by the text predicate underneath it: a `<` only
    // opens a tag when a name, `/`, or `>` follows it immediately, and the
    // comparison this could be confused with is written with a space.
    expect([...forEachTag('const m = { a: 1 } < limit;')].map((node) => node.name)).toEqual([]);
  });

  it('builds one tag index per source and shares it between interleaved walks (#4341)', () => {
    // The regex walk had to construct a fresh `/g` regex per call: these walks
    // genuinely interleave — the control scan is mid-walk when it asks
    // `hasMatchingLabelElement` about the same `'label'` — and a shared
    // `lastIndex` would leave the outer walk wherever the inner one finished.
    // An index is immutable, so re-entrancy costs nothing and the file is lexed
    // once instead of once per walk.
    const src = '<label htmlFor="a">A</label>\n<label htmlFor="b">B</label>';
    expect(tagIndexOf(src)).toBe(tagIndexOf(src));
    const outer = [];
    for (const node of forEachOpeningTag(src, 'label')) {
      outer.push(node.index);
      expect([...forEachOpeningTag(src, 'label')]).toHaveLength(2);
    }
    expect(outer).toHaveLength(2);
  });

  it('reads a quoted attribute as a string, not as tag structure (#4333)', () => {
    // Between a tag name and its `>` there is only attribute-value or
    // expression context, so a quote there always opens a string. Prose in an
    // attribute used to break `openingTagAt` two ways — both FALSE NEGATIVES,
    // which is why the suite stayed green with them present.
    // 1. A `>` ended the tag early, losing every attribute after it.
    expect(isNamed('<input type="text" placeholder="a > b" aria-label="Search" />')).toBe(true);
    // 2. A lone brace drove the depth negative and returned null. All 18 call
    //    sites read null as `continue`, so the <label> left the scan entirely
    //    and the input it names read as unnamed.
    expect(isNamed('<label htmlFor="a" title="use { to open">Rounds</label>\n<input id="a" type="text" />')).toBe(true);
    //    Same when the unbalanced brace is on the CONTROL's own tag.
    expect(isNamed('<input id="b" title="a } brace" aria-label="Search" />')).toBe(true);
    // The fix must not credit a control that still has no name: `placeholder`
    // is an anchor attribute, never an accessible name.
    expect(isNamed('<input type="text" placeholder="a > b" />')).toBe(false);

    // Inside `{…}` the context is no longer "tag", so the quote skip must NOT
    // apply there: `render={<span>don't</span>}` puts JSX text mid-tag, where an
    // apostrophe is an ordinary character. Reading it as a string opener runs
    // off the end of the file and returns null — the same class of bug, one
    // shape rarer. The expression is handed to `matchingBraceEnd` instead.
    const attrExpressions = [
      "<Foo render={<span>don't</span>} />",
      "<Foo x={/* don't */ 1} />",
      '<Foo c={`a > b`} />', // the case the original brace counting existed for
    ];
    for (const shape of attrExpressions) expect(openingTagAt(shape, 0)).toBe(shape);

    // `tagBoundaryAt` answers the same question for the icon rules and skipped
    // strings only at depth > 0, so a `>` in a top-level attribute value ended
    // the tag at the wrong character AND reported `selfClosing: false` — which
    // is how a self-closing icon stops looking self-closing.
    const iconTag = '<Icon title="a > b" />';
    expect(tagBoundaryAt(iconTag, 0)).toEqual({ end: iconTag.length, selfClosing: true });
  });

  it('hands a comment back to the context that opened it (#4333)', () => {
    // A comment can open from JavaScript or from inside a TAG. `maskComments`
    // reset to 'code' on exit either way, which dropped the lexer out of the
    // half-read tag: the tag's `>` no longer closed it, the element never
    // reached 'jsx-text', and the visible text after it was lexed as JavaScript
    // — so a `//` in ordinary label text got masked away. That is the #4318
    // failure again, reached through the comment states instead.
    for (const opener of ['// note\n', '/* note */']) {
      const src = `<Foo ${opener} bar="x">see // docs</Foo>`;
      expect(maskComments(src).endsWith('>see // docs</Foo>')).toBe(true);
    }
    // A comment opened from JavaScript still hands back to JavaScript.
    expect(maskComments('const a = 1; // note\nconst b = 2;')).toBe('const a = 1;        \nconst b = 2;');
  });

  it('reads a ternary operator through quoted attributes and strings (#4333)', () => {
    // An icon-only button whose ternary carries a `?` or `:` inside a string
    // used to read as "not a ternary" and drop out of the rule that requires it
    // to have a name — a false negative in a guard.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      const tag = openingTagAt(src, open);
      return isIconOnlyBody(findButtonBody(src, open + tag.length));
    };
    expect(isIconOnly("{mode === 'a?b' ? <IconA /> : <IconB />}")).toBe(true);
    expect(isIconOnly('{cond ? <IconA title="a:b" /> : <IconB />}')).toBe(true);
    // Optional chaining is still not a ternary, and a non-icon branch still
    // disqualifies the shape — the string skip must not widen either.
    expect(isIconOnly('{cond ? <IconA /> : "Save"}')).toBe(false);
    expect(isIconOnly('{icons?.primary}')).toBe(false);
  });

  it('masks an element body as JSX text, not as code (#4333)', () => {
    // `hasUsableElementText` hands `maskComments` a mid-file slice that is an
    // element BODY. Started in 'code' the machine opened a fake line comment on
    // the first `//` of visible label text, blanking the rest of the line — so a
    // correctly labeled input was reported UNNAMED.
    expect(maskComments('Discount 50 // 50', { startMode: 'jsx-text' })).toBe('Discount 50 // 50');
    expect(maskComments('Discount 50 // 50')).toBe('Discount 50      ');
    expect(isNamed('<label htmlFor="x">// see docs</label>\n<input id="x" type="text" />')).toBe(true);
    // A genuinely empty label still names nothing.
    expect(isNamed('<label htmlFor="y"></label>\n<input id="y" type="text" />')).toBe(false);
  });

  it('reads comments inside a brace expression as comments (#4333)', () => {
    // `matchingBraceEnd` is reached from UNMASKED source, and `soleTopLevelNode`
    // strips only `{/* … */}` — so a `//` or inline `/* */` inside the
    // expression reaches this walk raw. Both cases are silent: no error, just a
    // button that leaves the icon-only rule.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      const tag = openingTagAt(src, open);
      return isIconOnlyBody(findButtonBody(src, open + tag.length));
    };
    // A line comment whose text holds an apostrophe used to open a string that
    // never closed, so `matchingBraceEnd` returned -1 and the button vanished
    // from the rule entirely — a live false negative.
    expect(isIconOnly("{ // don't\n  open ? <Up /> : <Down /> }")).toBe(true);
    // A `}` inside a block comment used to be read as the closing brace: wrong
    // bounds with no error. This one is latent — no verdict flips today, since
    // a bare `{<Icon />}` is not an icon-only shape either way — so it is
    // pinned on the helper directly rather than through a rule that would pass
    // for the wrong reason.
    const blockComment = '{ /* } */ <Icon /> }';
    expect(matchingBraceEnd(blockComment, 0)).toBe(blockComment.length - 1);
    // Same inside a TAG, the walk's other JavaScript-ish context: an apostrophe
    // in the comment opened a string that ran to the end of the slice, and a
    // `>` in the comment ended the tag early and left the walk in element text.
    const tagComments = ["{ <Up /* don't */ /> }", '{ <Up /* a > b */ /> }'];
    for (const shape of tagComments) expect(matchingBraceEnd(shape, 0)).toBe(shape.length - 1);
    // Division and regex literals must not be mistaken for comment openers.
    expect(isIconOnly('{ ratio / 2 > 1 ? <Up /> : <Down /> }')).toBe(true);
    expect(isIconOnly('{ /up/.test(dir) ? <Up /> : <Down /> }')).toBe(true);
  });

  it('reads a regex literal as one token, not as JSX or a comment (#4333)', () => {
    // The last context outside the old model. A regex BODY may hold any of
    // `{ } ' " < >` and a character class may hold `/` itself, so every scanner
    // that walked one character by character could be started down a phantom
    // tag, string, or comment by ordinary product source.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      return isIconOnlyBody(findButtonBody(src, open + openingTagAt(src, open).length));
    };
    // `<` followed by `>` inside a character class opened a JSX tag: the rest of
    // the expression lexed as element text, so the `?` was no longer a top-level
    // operator and the button left the icon-only rule.
    expect(isIconOnly('{ /[<>]/.test(dir) ? <Up /> : <Down /> }')).toBe(true);
    // An apostrophe in a regex opened a string that never closed.
    expect(isIconOnly("{ /it's/.test(dir) ? <Up /> : <Down /> }")).toBe(true);
    // A `//` inside a character class read as a line comment and blanked the
    // rest of the line — including, here, the label text that follows it.
    expect(maskComments('const re = /[//]/;\n<label htmlFor="x">Rounds</label>'))
      .toBe('const re = /[//]/;\n<label htmlFor="x">Rounds</label>');
    // Guessing has to stay conservative in the other direction: a `/` after a
    // VALUE is division, and a regex may not span a line, so an unmatched `/`
    // was division after all. Neither may swallow the code that follows.
    expect(maskComments('const r = (a) / b; // note\nconst s = c[0] / d;'))
      .toBe('const r = (a) / b;        \nconst s = c[0] / d;');
    expect(maskComments('const r = x = / not a regex\nconst s = 1; // note'))
      .toBe('const r = x = / not a regex\nconst s = 1;        ');
  });

  it('asks what TOKEN precedes a slash, not what character does (#4333)', () => {
    // Whether a `/` opens a regex — and whether a `<` opens a tag — is a
    // question about the preceding TOKEN. Two shapes where that is not the
    // preceding CHARACTER, each putting the literal's own `<>` back into the
    // JavaScript walk, where it opens a tag that never closes and leaves the
    // rest of the expression lexing as element text.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      return isIconOnlyBody(findButtonBody(src, open + openingTagAt(src, open).length));
    };
    // 1. An arrow function returning a literal — the most common regex shape in
    //    this tree. The preceding character is the `>` of `=>`, which ends no
    //    value, so `>` has to count as a regex preceder.
    expect(isIconOnly('{ ((d) => /[<>]/.test(d))(x) ? <Up /> : <Down /> }')).toBe(true);
    // 2. A comment between the operator and the literal. A backward walk over
    //    raw source stops at the `/` of the `*/` and calls this division; only
    //    the forward pass knows the comment was not a token.
    expect(isIconOnly('{ /* why */ /[<>]/.test(d) ? <Up /> : <Down /> }')).toBe(true);
    // The same blind spot decided whether a `<` opened a tag, so a comment
    // before an element left the lexer in JavaScript — and the visible text of
    // a correctly labeled control masked away as code.
    const commented = 'const el = /* why */ <label htmlFor="r">see // docs</label>;\n<input id="r" type="text" />';
    expect(maskComments(commented)).toBe(commented.replace('/* why */', '         '));
    expect(isNamed(commented)).toBe(true);
    // And it decides whether a tag closed itself, where the character before the
    // `>` is the `/` of a `*/` — an opening tag that reads as self-closing takes
    // its whole body out of every rule that walks children.
    expect(tagBoundaryAt('<Foo /* note */ >', 0)).toEqual({ end: 17, selfClosing: false });
    expect(tagBoundaryAt('<Foo /* note */ />', 0)).toEqual({ end: 18, selfClosing: true });
  });

  it('bounds a regex literal at the line, and reads the keywords that open one (#4333)', () => {
    // Latent today — no tracked file hits either — so both are pinned on the
    // helper directly rather than through a rule that would pass for the wrong
    // reason. Getting either wrong hands the literal's own characters back to
    // the JavaScript walk, which is what the state exists to prevent.
    //
    // A `\` escapes the next character but never the line bound, so a trailing
    // one is a syntax error, not a continuation. Stepping over it blind let a
    // `/` on a later line close the "literal".
    expect(regexEnd('x = /a\\\n/;', 4, 2)).toBe(-1);
    expect(regexEnd('x = /a\\//;', 4, 2)).toBe(8);
    // `throw` and `default` open a regex exactly as `return` does.
    expect(regexEnd('throw /[<>]/;', 6, 4)).toBe(11);
    expect(regexEnd('export default /[<>]/;', 15, 13)).toBe(20);
    // A `/` after a VALUE is still division, keyword-shaped names included.
    expect(regexEnd('const rethrow = a / b;', 18, 16)).toBe(-1);
  });

  it('keeps the mask in the same index space as the source (#4333)', () => {
    // `jsxScanner` reports STRING indexes, so the mask has to be a UTF-16 split.
    // Against a code-point split (`[...src]`) an astral character collapses to
    // one slot, and from the first emoji onward every blank lands a slot early —
    // here leaving a stray `/` behind and eating the newline's neighbour. 72
    // tracked client files carry an emoji, so this is live, not theoretical.
    expect(maskComments('const icon = \'🚀\'; // note\nconst b = 2;'))
      .toBe('const icon = \'🚀\';        \nconst b = 2;');
    // And the shifted reads take the lexer with them: the `<` of a tag is no
    // longer where the machine looks, so it never enters tag context and the
    // visible text of a correctly labeled control masks away as code.
    const labelled = 'const icon = \'🚀\';\n<label htmlFor="x">see // docs</label>\n<input id="x" type="text" />';
    expect(maskComments(labelled)).toBe(labelled);
    expect(isNamed(labelled)).toBe(true);
  });

  it('reads a call\'s arguments through unbalanced parens in JSX text (#4333)', () => {
    // The toast rule slices `toast(…)` out of raw source. A `(` or `)` in an
    // element's visible text is prose, not structure — `:(` alone left the call
    // unbalanced, so the slice came back null and the rule silently skipped the
    // one shape it exists to catch: JSX content with no `label`.
    const smiley = 'toast(<p>Sync failed :( sorry</p>, { duration: Infinity })';
    expect(balancedCallAt(smiley, smiley.indexOf('('))).toBe(smiley.slice(smiley.indexOf('(')));
    const closer = 'toast(<p>Sync failed :) sorry</p>, { duration: Infinity })';
    expect(balancedCallAt(closer, closer.indexOf('('))).toBe(closer.slice(closer.indexOf('(')));
  });

  it('takes brace nesting from the scanner, not a local counter (#4333)', () => {
    // `topLevelOperatorIn` sees only JavaScript-context characters, and a `{…}`
    // child expression opens in ELEMENT TEXT and closes in JavaScript. A local
    // `{`/`}` counter therefore misses the open and still sees the close, going
    // negative and never matching `depth === 0` again — so nothing after the
    // first rendered expression is ever found. Latent today (no verdict flips),
    // and pinned on the helper for the same reason the block-comment case is.
    const withChildExpression = 'render(<p>{x}</p>) ? <Up /> : <Down />';
    expect(topLevelOperatorIn(withChildExpression, '?', 0)).toBe(withChildExpression.indexOf('?'));
    expect(topLevelOperatorIn(withChildExpression, ':', withChildExpression.indexOf('?') + 1))
      .toBe(withChildExpression.indexOf(':'));
  });

  it('reads an apostrophe in JSX text as text, not a string opener (#4318)', () => {
    // `matchingBraceEnd` used to treat `'` as a string delimiter everywhere. In
    // JSX element text it is an ordinary character, so a brace expression
    // containing one never found its closing brace: the helper returned -1 and
    // every recognizer built on it — the conditional-child credit above, the
    // component-body walk the wrapper registry runs on — silently saw nothing.
    // This is the shape that left pages/AIProviders.jsx's fallback-model
    // controls on the allowlists while their four identical siblings passed.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Fallback Model">\n  ${child}\n</FormField>`;

    const apostrophe = field(`{opts.length > 0 ? (<select><option value="">Use the provider's default</option></select>) : (<input type="text" placeholder="Use the provider's default" />)}`);
    expect(isNamed(apostrophe, 'select')).toBe(true);
    expect(isNamed(apostrophe, 'input')).toBe(true);

    // A quote in JavaScript-expression context is still a delimiter, so a `}`
    // inside a string cannot pass for the expression's end — that would cut the
    // scan short of the control and lose the credit the other way.
    const braceInString = field(`{mode === 'a}b' ? (<select><option>a</option></select>) : (<input type="text" />)}`);
    expect(isNamed(braceInString, 'select')).toBe(true);

    // The fix widens what the scanner can READ, not what it credits: with the
    // apostrophe in element text — the position that used to blind the scan —
    // the rendered-list veto still applies now that the bounds are legible.
    const list = field(`{fields.map((f) => (<select key={f}><option>it's here</option></select>))}`);
    expect(isNamed(list, 'select')).toBe(false);
  });

  it('recognizes a wrapper wherever it is declared and however it names', () => {
    // The registry splits "where the wrapper lives" from "how it names", so
    // every combination has to work — the arrow-function and imported-wrapper
    // quadrants were unreachable before #4317, and the cheapest way to make a
    // new control pass a guard that misses its wrapper is an `aria-label` that
    // shadows the visible label the wrapper already renders.
    // An arrow-function implicit wrapper, in both body forms.
    const parenArrow = 'const Field = ({ label, children }) => (\n  <label className="block"><span>{label}</span>{children}</label>\n);\n<Field label="Rounds"><input type="number" /></Field>';
    expect(isNamed(parenArrow)).toBe(true);
    expect(isNamed(parenArrow.replace('label="Rounds"', ''))).toBe(false);
    const blockArrow = `const Field = ({ label, children }) => {
  return (<label className="block"><span>{label}</span>{children}</label>);
};
<Field label="Rounds"><input type="number" /></Field>`;
    expect(isNamed(blockArrow)).toBe(true);

    // An arrow-function htmlFor forwarder.
    const arrowForwarder = 'const Group = ({ id, label, children }) => (\n  <div><label htmlFor={id}>{label}</label>{children}</div>\n);\n<Group id="rounds" label="Rounds"><input id="rounds" type="number" /></Group>';
    expect(isNamed(arrowForwarder)).toBe(true);
    expect(isNamed(arrowForwarder.replace(' label="Rounds"', ''))).toBe(false);

    // An IMPORTED wrapper, resolved and read: components/ui/FormField.jsx is
    // the cloning shape, and its default export is credited through whatever
    // name the call site binds it to.
    const importedCloner = "import FormField from '../ui/FormField';\n<FormField label=\"Rounds\"><input type=\"number\" /></FormField>";
    expect(isNamed(importedCloner)).toBe(true);
    const renamedBinding = 'import Wrapped from \'../ui/FormField\';\n<Wrapped label="Rounds"><input type="number" /></Wrapped>';
    expect(isNamed(renamedBinding)).toBe(true);
    // An unresolvable specifier is not credited: there is no source to read, so
    // the name alone proves nothing.
    expect(isNamed(importedCloner.replace("'../ui/FormField'", "'./NotAFile'"))).toBe(false);
    // Neither is a resolvable import of a component that names no control.
    const importedNonWrapper = 'import Drawer from \'../Drawer\';\n<Drawer label="Rounds"><input type="number" /></Drawer>';
    expect(isNamed(importedNonWrapper)).toBe(false);

    // A same-file cloning wrapper — the quadrant the hardcoded `FormField`
    // name could never reach. The clone is what proves the generated id gets
    // to the child; without it the <label> points at a local that goes nowhere.
    const localCloner = `function Boxed({ label, children }) {
  const controlId = useId();
  const augmented = Children.map(children, (child, i) => (i === 0 ? cloneElement(child, { id: controlId }) : child));
  return (<div><label htmlFor={controlId}>{label}</label>{augmented}</div>);
}
<Boxed label="Rounds"><input type="number" /></Boxed>`;
    expect(isNamed(localCloner)).toBe(true);
    expect(isNamed(localCloner.replace('cloneElement(child, { id: controlId })', 'child'))).toBe(false);
    expect(isNamed(localCloner.replace(' label="Rounds"', ''))).toBe(false);
    // A <label> that renders no text names nothing, in any quadrant.
    expect(isNamed(localCloner.replace('>{label}<', '><'))).toBe(false);
    expect(isNamed(parenArrow.replace('<span>{label}</span>', ''))).toBe(false);

    // A prop the <label> passes to a nested element's ATTRIBUTE renders no
    // text — `<span className={label} aria-hidden />` puts nothing in the
    // accessible name. Reading it as the label's text would exempt a control
    // that really is unnamed, which is the one failure direction this guard
    // cannot afford.
    const attributeOnlyProp = 'const Field = ({ label, children }) => (\n  <label><span className={label} aria-hidden="true" />{children}</label>\n);\n<Field label="theme-icon"><input type="text" /></Field>';
    expect(isNamed(attributeOnlyProp)).toBe(false);
    const forwarderAttributeOnlyProp = `function TooltipLabel({ htmlFor, label, children }) {
  return (<label htmlFor={htmlFor}><span data-tooltip={label} aria-hidden="true" />{children}</label>);
}
<TooltipLabel htmlFor="rounds" label="tooltip text" />
<input id="rounds" type="number" />`;
    expect(isNamed(forwarderAttributeOnlyProp)).toBe(false);

    // A cloning wrapper that clones onto an INDEXED child names that child, not
    // the first one — and the call-site check credits the first. Only a bare
    // `Children.map` callback parameter counts as the clone target.
    const indexedClone = localCloner.replace('cloneElement(child, { id: controlId })', 'cloneElement(children[1], { id: controlId })');
    expect(isNamed(indexedClone)).toBe(false);
    // …and a wrapper that clones onto an element it built for ITSELF never
    // touches the caller's child, so the caller's control stays unnamed.
    const internalClone = `function Boxed({ label, children }) {
  const controlId = useId();
  const own = <div />;
  const cloned = cloneElement(own, { id: controlId });
  return (<div><label htmlFor={controlId}>{label}</label>{cloned}{children}</div>);
}
<Boxed label="Rounds"><input type="number" /></Boxed>`;
    expect(isNamed(internalClone)).toBe(false);

    // A `>` inside a quoted attribute value must not end the tag early — the
    // rest of the tag would survive as "text" and its attributes would read as
    // rendered props, re-opening the attribute-only bypass above.
    const angleBracketInAttribute = 'const Field = ({ label, children }) => (\n  <label><span title=">" data-tooltip={label} />{children}</label>\n);\n<Field label="Help text"><input type="text" /></Field>';
    expect(isNamed(angleBracketInAttribute)).toBe(false);
  });

  it('decodes a wrapped default export and a re-export barrel (#4327)', () => {
    // The registry resolves an imported wrapper by READING the imported file,
    // so an export idiom it cannot decode reports "not a wrapper" for a wrapper
    // it never opened — the absent-vs-empty collapse, and the same silent false
    // negative #4317 was filed to close. Neither idiom has a live label-wrapper
    // witness in the tree (this repo's barrels forward pages, not wrappers, and
    // its `export default memo(…)` components are not label wrappers), so the
    // fixtures stand in as virtual modules and the assertion still runs through
    // the real scan rather than through a hand-called decoder.
    const DIR = 'src/components/settings';
    const implicit = (name) => `function ${name}({ label, children }) {
  return (<label className="block"><span>{label}</span>{children}</label>);
}`;
    const callSite = (specifier, binding, clause = binding) =>
      `import ${clause} from '${specifier}';\n<${binding} label="Rounds"><input type="number" /></${binding}>`;

    // 1. A default export wrapped in HOC calls. `export default memo(Field)` is
    // a live idiom here (grep `export default memo(`), and the old
    // `export default (function )?Name` pattern yields nothing for all of these
    // — `memo` is not the component, and it is not capitalized either.
    for (const wrapped of ['memo(Field)', 'React.memo(Field)', 'memo(forwardRef(Field))']) {
      const src = `${implicit('Field')}\nexport default ${wrapped};`;
      const named = withVirtualSources({ [`${DIR}/Wrapped.jsx`]: src }, () =>
        isNamed(callSite('./Wrapped', 'Field')));
      expect(named, `default export \`${wrapped}\` was not decoded`).toBe(true);
    }
    // The declaration form inside the HOC, where the parens after the name are
    // a parameter list rather than a call to unwrap.
    const inlineDeclaration = `export default forwardRef(function Field({ label, children }) {
  return (<label className="block"><span>{label}</span>{children}</label>);
});`;
    expect(withVirtualSources({ [`${DIR}/Inline.jsx`]: inlineDeclaration }, () =>
      isNamed(callSite('./Inline', 'Field')))).toBe(true);

    // An anonymous wrapped default names no declared component, so there is
    // nothing to look up — and guessing would credit whatever capitalized name
    // sat nearby. Unnamed is the safe direction: the control stays allowlisted.
    const anonymous = 'export default memo(({ label, children }) => (\n  <label className="block"><span>{label}</span>{children}</label>\n));';
    expect(withVirtualSources({ [`${DIR}/Anon.jsx`]: anonymous }, () =>
      isNamed(callSite('./Anon', 'Field')))).toBe(false);
    // …as is a wrapped default whose component is not a wrapper at all.
    const notAWrapper = 'function Field({ label, children }) {\n  return (<div>{label}{children}</div>);\n}\nexport default memo(Field);';
    expect(withVirtualSources({ [`${DIR}/Plain.jsx`]: notAWrapper }, () =>
      isNamed(callSite('./Plain', 'Field')))).toBe(false);

    // 2. A re-export barrel. `resolveRelativeImport` already resolves `../ui`
    // to its index file; before this, that index declared no components and the
    // registry stopped there.
    const barrel = (line) => ({
      [`${DIR}/kit/index.js`]: line,
      [`${DIR}/kit/Field.jsx`]: `${implicit('Field')}\nexport default Field;`,
      [`${DIR}/kit/Named.jsx`]: implicit('Named').replace('function', 'export function'),
    });
    expect(withVirtualSources(barrel("export { default as Field } from './Field';"), () =>
      isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(true);
    // The aliasing has to survive the hop: `Named` is what the source module
    // exports, `Field` is what the call site renders.
    expect(withVirtualSources(barrel("export { Named as Field } from './Named';"), () =>
      isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(true);
    // A barrel that forwards a name it cannot resolve credits nothing.
    expect(withVirtualSources(barrel("export { default as Field } from './Missing';"), () =>
      isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(false);
    // Neither does one whose target is a component that names no control.
    expect(withVirtualSources({
      ...barrel("export { default as Field } from './Field';"),
      [`${DIR}/kit/Field.jsx`]: 'function Field({ label, children }) {\n  return (<div>{label}{children}</div>);\n}\nexport default Field;',
    }, () => isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(false);

    // The stand-ins are torn down with the caches they seeded, so a rule that
    // reads real source can never observe one.
    expect(virtualSources.size).toBe(0);
    expect(maskedSourceByFile.has(`${DIR}/kit/index.js`)).toBe(false);
  });

});
