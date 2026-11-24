/**
 * Accessibility conventions: tablists, menus, radiogroups, live regions, landmarks and coarse-pointer text.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { CLIENT_ROOT, trackedJsxFiles, trackedSourceFiles, maskedSourceOf, rawSourceOf, forEachOpeningTag, lineOf } from '../../a11yScanCore.js';
import { attributeValue, normalizedAttributeValue, maskComments } from '../../a11yScanNames.js';
import { guardExpressionBefore, JUSTIFIED_SILENT_ERROR_RENDERS, silentErrorRenders } from '../../a11yScanRules.js';
import { readText } from '../../../../../scripts/lib/guardCorpus.js';

const LAYOUT_FREE_MAIN_FILES = [
  'src/components/PageShell.jsx',
  'src/pages/Ambient.jsx',
  'src/pages/Eidoverse.jsx',
  'src/pages/EidoverseGuest.jsx',
  'src/pages/FableLoomHostedJoin.jsx',
  'src/pages/Login.jsx',
];

describe('a11y conventions: landmarks', () => {
  // Every element whose `role` attribute literally reads "tablist", wherever
  // one is written. Reading the answer off the parsed tag covers
  // `role="tablist"`, `role='tablist'` and `role={'tablist'}` as one question;
  // a commented-out example is masked before the walk, a `title` attribute's
  // text is never a tag's `role`, and a dynamic `role={expr}` resolves to no
  // verdict — left to review rather than guessed at.
  const handRolledTablists = function* (src) {
    // 'tablist' absent → lexing the file cannot yield a tablist tag.
    if (!src.includes('tablist')) return;
    for (const node of forEachOpeningTag(src)) {
      if (normalizedAttributeValue(attributeValue(node.tag, 'role')) === 'tablist') yield node;
    }
  };

  it('routes every tablist through the shared <TabPills> primitive (#7244)', () => {
    // Probe first — the tree is green by construction (the four audited sites
    // moved onto TabPills in the same change), so nothing in it pins what the
    // walk rejects, and a silent change of shape would turn the rule vacuous.
    const probe = (src) => [...handRolledTablists(src)].map(({ index }) => lineOf(src, index));
    expect(probe('<div role="tablist" aria-label="X"><button role="tab">A</button></div>')).toEqual([1]);
    // …whichever way the literal is spelled, and wherever the tag starts.
    expect(probe("<p>x</p>\n<div\n  role='tablist'\n/>")).toEqual([2]);
    expect(probe('<div role={"tablist"} />')).toEqual([1]);
    expect(probe('<div role="tablist" /><nav role="tablist" />')).toEqual([1, 1]);
    // The shared primitive's call site carries no `role` — it is the answer,
    // not the question.
    expect(probe('<TabPills tabs={tabs} activeTab={a} onChange={c} />')).toEqual([]);
    // A bare role="tab" outside a list is a different defect, and a dynamic
    // role is unverifiable — both are out of this rule's remit.
    expect(probe('<div role="tab" /><div role={roleFor(kind)} />')).toEqual([]);
    // A JSX example written in a comment is masked before the walk, and a
    // mention inside another attribute's quoted value is never read as a role.
    expect(probe(maskComments('{/* <div role="tablist" /> */}'))).toEqual([]);
    expect(probe('<div data-note="x" title="see tablist docs" />')).toEqual([]);

    // Prove the walk sees the real spelling on the shared component itself —
    // a matcher that silently missed it would pass the tree vacuously.
    expect(
      [...handRolledTablists(maskedSourceOf('src/components/ui/TabPills.jsx'))].length,
      'components/ui/TabPills.jsx no longer writes role="tablist" — has the primitive changed shape?',
    ).toBeGreaterThanOrEqual(1);

    const offenders = [];
    for (const file of trackedSourceFiles()) {
      if (file === 'src/components/ui/TabPills.jsx') continue;
      const src = maskedSourceOf(file);
      for (const { index } of handRolledTablists(src)) {
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `Hand-rolled role="tablist" — render the shared components/ui/TabPills.jsx instead; it owns the roving tabindex + Arrow/Home/End contract a hand-rolled bar cannot honor (WCAG 4.1.2):\n${offenders.join('\n')}`).toEqual([]);
  });

  // --- menu roles only where the contract is implemented (#7265) --------------
  //
  // `role="menu"` is the same class of promise as `role="tablist"` — screen
  // readers suppress the browse cursor inside it and drive the contents with
  // ArrowUp/ArrowDown roving focus, Home/End jumps, and Escape returning focus
  // to the trigger. Claiming the role without implementing those keys makes
  // the contents unreachable by the means the role announced (WCAG 4.1.2), and
  // a menu may only own menuitem/group/separator children — a textbox or form
  // inside it is an additional violation. Two components keep the contract:
  // `components/ui/OverflowMenu.jsx` and `components/ThemeSwitcher.jsx`. The
  // seven audited popovers that didn't dropped the claim in #7265 — the
  // `ShellProviderLauncher.jsx` precedent, which keeps a plain named group of
  // controls that Tab reaches natively. This scan is the backstop that keeps
  // the eighth copy from landing.

  // Files allowed to write menu-family roles — each implements the arrow-key
  // contract itself. The allowlist only shrinks; a new compliant menu goes
  // through `ui/OverflowMenu.jsx` instead of re-deriving the semantics.
  const MENU_CONTRACT_ALLOWLIST = new Set([
    'src/components/ui/OverflowMenu.jsx',
    'src/components/ThemeSwitcher.jsx',
  ]);

  // The whole menu role family, not just "menu": BulkTargetPicker's rows were
  // `role="menuitem"` in a different file than the `role="menu"` container, so
  // a menu-only scan would have missed the row half of the audited defect.
  const MENU_CONTRACT_ROLES = new Set(['menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio']);

  // The file-level "did anyone implement the promised keys" question. Any
  // arrow key counts — a `menubar` legitimately answers Left/Right where a
  // `menu` answers Up/Down. Comments are masked before this runs, so a doc
  // comment mentioning ArrowDown can't forge the exemption.
  const implementsArrowKeys = (src) => /\bArrow(?:Up|Down|Left|Right)\b/.test(src);

  // Every element whose `role` attribute literally reads a menu-family role.
  // Reading the answer off the parsed tag covers `role="menu"`, `role='menu'`
  // and `role={'menu'}` as one question; a commented-out example is masked
  // before the walk; a `closest('[role="menu"]')` selector string
  // (meatspace/post/ElementsSong.jsx) is never a tag's role; and a dynamic
  // `role={expr}` resolves to no verdict — left to review rather than guessed.
  const menuContractSites = function* (src) {
    // 'menu' absent → lexing the file cannot yield a menu-family tag.
    if (!src.includes('menu')) return;
    for (const node of forEachOpeningTag(src)) {
      if (MENU_CONTRACT_ROLES.has(normalizedAttributeValue(attributeValue(node.tag, 'role')))) yield node;
    }
  };

  it('ships menu roles only where arrow-key focus management backs them (#7265)', () => {
    const offendersIn = (file, src) => {
      if (MENU_CONTRACT_ALLOWLIST.has(file)) return [];
      const sites = [...menuContractSites(src)];
      if (sites.length === 0 || implementsArrowKeys(src)) return [];
      return sites.map(({ index }) => `${file}:${lineOf(src, index)}`);
    };

    // Probes first — the tree is green by construction, so fixtures carry the
    // proof that the walk rejects what the rule exists to reject.
    const probe = (src, file = 'src/components/probe/Probe.jsx') => offendersIn(file, src);
    // The audited shape: a menu claim with no arrow-key handling behind it.
    expect(probe('<div role="menu"><button role="menuitem">A</button></div>'))
      .toEqual(['src/components/probe/Probe.jsx:1', 'src/components/probe/Probe.jsx:1']);
    // A bare menuitem in a file with no menu container is the same broken
    // contract — the row half of the audited defect lived in its own file.
    expect(probe('<ul><li><button role="menuitemcheckbox">B</button></li></ul>'))
      .toEqual(['src/components/probe/Probe.jsx:1']);
    // Whichever way the literal is spelled, and wherever the tag starts.
    expect(probe("<ul\n  role='menu'\n/>")).toEqual(['src/components/probe/Probe.jsx:1']);
    expect(probe('<div role={"menu"} />')).toEqual(['src/components/probe/Probe.jsx:1']);
    // A menu WITH arrow-key handling keeps its contract — allowed anywhere.
    expect(probe('const onKey = (e) => e.key === "ArrowDown" && focusNext();\n<div role="menu" onKeyDown={onKey} />')).toEqual([]);
    expect(probe('const onKey = (e) => e.key === "ArrowRight" && focusNext();\n<div role="menubar" onKeyDown={onKey} />')).toEqual([]);
    // The allowlisted primitives are exempt by name.
    expect(probe('<div role="menu" />', 'src/components/ui/OverflowMenu.jsx')).toEqual([]);
    expect(probe('<div role="menuitemradio" />', 'src/components/ThemeSwitcher.jsx')).toEqual([]);
    // A selector string is not a role attribute, a commented example is masked
    // before the walk, and a dynamic role is unverifiable — out of remit.
    expect(probe('<div onKeyDown={(e) => e.target.closest?.("[role=\\"menu\\"]") && f()} />')).toEqual([]);
    expect(probe(maskComments('{/* <div role="menu" /> */}'))).toEqual([]);
    expect(probe('<div data-note="menu" role={roleFor(kind)} />')).toEqual([]);
    // A comment naming the keys does not forge the exemption either.
    expect(probe(maskComments('// ArrowDown is handled by the caller\n<div role="menu" />')))
      .toEqual(['src/components/probe/Probe.jsx:2']);

    // The allowlist is pinned to reality: both primitives must still write a
    // menu-family role AND still implement the keys that exempt them.
    for (const allowed of MENU_CONTRACT_ALLOWLIST) {
      const src = maskedSourceOf(allowed);
      expect(
        [...menuContractSites(src)].length,
        `${allowed} no longer writes a menu-family role — drop it from MENU_CONTRACT_ALLOWLIST`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        implementsArrowKeys(src),
        `${allowed} lost its arrow-key handling — the role now promises keys nothing answers`,
      ).toBe(true);
    }

    const offenders = [];
    for (const file of trackedSourceFiles()) {
      offenders.push(...offendersIn(file, maskedSourceOf(file)));
    }
    expect(offenders, `Menu-family role without arrow-key focus management — a role="menu" promises ArrowUp/ArrowDown roving focus, Home/End and Escape-to-trigger that a hand-rolled popover doesn't implement (WCAG 4.1.2). Drop the role (the ShellProviderLauncher.jsx precedent: a named group of plain controls needs none) or route the popover through components/ui/OverflowMenu.jsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  // --- radiogroup owns radios and arrow keys (#17562) -------------------------
  //
  // `role="radiogroup"` promises one tab stop and Arrow/Home/End selection
  // (WAI-ARIA 1.2 Radio Group, WCAG 4.1.2). A group of `aria-pressed` toggles
  // is `role="group"`. Arrow handling is `onRadioGroupKeyDown` from
  // `lib/a11yKeyboard.js`, or an in-file Arrow* handler. The group may own
  // `role="radio"` controls only — a plain button inside it is a second violation.

  const implementsRadioKeys = (src) => src.includes('onRadioGroupKeyDown') || /\bArrow(?:Up|Down|Left|Right)\b/.test(src);

  const elementRole = (node) => normalizedAttributeValue(attributeValue(node.tag, 'role'));

  const radioGroupSites = function* (src) {
    if (!src.includes('radiogroup')) return;
    for (const node of forEachOpeningTag(src)) {
      if (elementRole(node) === 'radiogroup') yield node;
    }
  };

  // Openers nested in `group`, stopping at its matching close. A sibling that
  // follows the group is not owned by it.
  const ownedOpeners = (src, group) => {
    const end = group.matchingClose?.index ?? src.length;
    const owned = [];
    for (const node of forEachOpeningTag(src)) {
      if (node.index <= group.index || node.index >= end) continue;
      owned.push(node);
    }
    return owned;
  };

  const radioGroupOffendersIn = (file, src) => {
    const sites = [...radioGroupSites(src)];
    if (sites.length === 0) return [];
    const keys = implementsRadioKeys(src);
    const offenders = [];
    for (const site of sites) {
      const owned = ownedOpeners(src, site);
      const radios = owned.filter((node) => elementRole(node) === 'radio');
      const strayControls = owned.filter((node) => (
        (node.name === 'button' || node.name === 'a' || node.name === 'input')
        && elementRole(node) !== 'radio'
      ));
      if (radios.length === 0 || strayControls.length > 0 || !keys) {
        offenders.push(`${file}:${lineOf(src, site.index)}`);
      }
    }
    return offenders;
  };

  it('ships radiogroups only with radio children and arrow-key handling (#17562)', () => {
    const probe = (src, file = 'src/components/probe/Probe.jsx') => radioGroupOffendersIn(file, src);
    expect(probe('<div role="radiogroup" aria-label="Background"><button aria-pressed="true">A</button></div>'))
      .toEqual(['src/components/probe/Probe.jsx:1']);
    expect(probe('<div role="radiogroup"><button role="radio">A</button></div>'))
      .toEqual(['src/components/probe/Probe.jsx:1']);
    expect(probe('<div role="radiogroup"><button role="radio">A</button><button>Gallery image…</button></div>'))
      .toEqual(['src/components/probe/Probe.jsx:1']);
    expect(probe('<div role="radiogroup" onKeyDown={onRadioGroupKeyDown}><button role="radio">A</button></div>')).toEqual([]);
    expect(probe('const onKey = (e) => e.key === "ArrowRight";\n<div role="radiogroup" onKeyDown={onKey}><button role="radio">A</button></div>')).toEqual([]);
    expect(probe("<div\n  role='radiogroup'\n><button role={'radio'}>A</button></div>"))
      .toEqual(['src/components/probe/Probe.jsx:1']);
    expect(probe(maskComments('{/* <div role="radiogroup" /> */}'))).toEqual([]);
    expect(probe('<div onKeyDown={onRadioGroupKeyDown}><button role="radio">A</button></div>')).toEqual([]);
    expect(probe('<div role="group" aria-label="Preview background"><button aria-pressed="true">A</button></div>')).toEqual([]);

    const offenders = [];
    for (const file of trackedSourceFiles()) {
      offenders.push(...radioGroupOffendersIn(file, maskedSourceOf(file)));
    }
    expect(offenders, `role="radiogroup" without role="radio" children or arrow-key handling — wire onRadioGroupKeyDown from lib/a11yKeyboard.js and keep non-radio actions outside the group (WCAG 4.1.2). Toggle clusters use role="group":\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every conditional error render a live region (#7266)', () => {
    // Probe first — the tree is green by construction (this change swept it),
    // so nothing left in it pins what the walk rejects, and a silent change of
    // shape would turn the rule into a vacuous pass over zero matches.
    const probe = (src) => [...silentErrorRenders(src, 'probe.jsx')].map(({ index }) => lineOf(src, index));
    expect(probe('{error && <div>{error}</div>}')).toEqual([1]);
    expect(probe('{saveError && (\n  <p className="x">{saveError}</p>\n)}')).toEqual([2]);
    // Every accepted answer silences it: role, aria-live, or the shared Banner.
    expect(probe('{error && <div role="alert">{error}</div>}')).toEqual([]);
    expect(probe('{error && <div role="status">{error}</div>}')).toEqual([]);
    expect(probe('{error && <div aria-live="polite">{error}</div>}')).toEqual([]);
    expect(probe('{error && <Banner tone="error">{error}</Banner>}')).toEqual([]);
    // …and a live region anywhere on the path covers what is inside it, in
    // either direction: an ancestor that announces, or a wrapper that delegates
    // to a Banner it renders.
    expect(probe('<div role="alert">{error && <span>{error}</span>}</div>')).toEqual([]);
    expect(probe('{error && <div><Banner tone="error">{error}</Banner></div>}')).toEqual([]);

    // A NEGATED guard renders the success path, not the failure — announcing a
    // page's normal content as a status message is its own defect.
    expect(probe('{!loadError && <div>{model.name}</div>}')).toEqual([]);
    expect(probe('{ready && !error && <div>done</div>}')).toEqual([]);
    // A guard that names no error is out of remit, however close it reads…
    expect(probe('{preferredTone && <div>{preferredTone}</div>}')).toEqual([]);
    // A standard Error is read through its properties, so the guard names it at
    // the ROOT of the path rather than at the tail.
    expect(probe('{error.message && <div>{error.message}</div>}')).toEqual([1]);
    expect(probe('{err.details && <div>{err.details}</div>}')).toEqual([1]);
    // Deliberately NOT the middle of a path: `insights.recentUnknownErrors.length`
    // names a COUNT on an analytics record, and reading every segment turns a
    // panel that was always on screen into a status message.
    expect(probe('{insights.recentUnknownErrors.length > 0 && <div>samples</div>}')).toEqual([]);
    // A comparison is not a truthiness check. `=== 'error'` IS the error state;
    // `!==` renders when two values differ — the success path, or a detail
    // beside an error already on screen — and `=== null` is success spelled
    // backwards.
    expect(probe("{state.status === 'error' && <div>failed</div>}")).toEqual([1]);
    expect(probe("{lastRun.errorCode === 'HF_AUTH' && <div>sign in</div>}")).toEqual([1]);
    expect(probe("{status !== 'error' && <div>{model.name}</div>}")).toEqual([]);
    expect(probe('{error === null && <div>done</div>}')).toEqual([]);
    // A guard holding a comparison must survive the walk back to its `{` — the
    // `>` in it is not a tag boundary.
    expect(probe('{errorContext?.missing?.length > 0 && <p>Unresolved</p>}')).toEqual([1]);
    // …but JSX TEXT holding a bare `&&` is not a guard, and the walk must not
    // cross the enclosing tag to pretend it is.
    expect(probe('<div className="x">retry && <span>{error}</span></div>')).toEqual([]);
    // …and only the LAST operand is the guard; an error precondition on a
    // render of something else is not an error message.
    expect(probe('{error && retryCount && <div>{retryCount}</div>}')).toEqual([]);
    expect(probe('{loading && error && <div>{error}</div>}')).toEqual([1]);
    // Controls are reached by tabbing and own their own semantics — a
    // conditionally-rendered <button>/<a>/component is a different question.
    expect(probe('{error && <button onClick={retry}>Retry</button>}')).toEqual([]);
    expect(probe('{error && <ErrorCard error={error} />}')).toEqual([]);
    // A `&&` that is not a JSX guard must not drag the next element in.
    expect(probe('const shown = a && b;\n<div>{x}</div>')).toEqual([]);
    // A JSX example written in a comment is masked before the walk.
    expect(probe(maskComments('{/* {error && <div>{error}</div>} */}'))).toEqual([]);

    // Prove the walk still sees the shape on a real file — an allowlisted entry
    // is only meaningful while the matcher would otherwise have flagged it.
    for (const [file, expressions] of JUSTIFIED_SILENT_ERROR_RENDERS) {
      const src = maskedSourceOf(file);
      const flagged = [...silentErrorRenders(src, `${file}.unallowlisted`)]
        .map(({ index }) => guardExpressionBefore(src, index));
      for (const expression of expressions) {
        expect(flagged, `${file} no longer renders \`${expression}\` — retire the allowlist entry`).toContain(expression);
      }
    }

    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = maskedSourceOf(file);
      for (const node of silentErrorRenders(src, file)) {
        offenders.push(`${file}:${lineOf(src, node.index)}`);
      }
    }
    expect(offenders, `Conditionally-rendered error text that announces nothing — render <Banner tone="error"> (it supplies role="alert" itself), or add role="alert" for an error the user's own action produced and role="status" for a passive load failure (WCAG 4.1.3):\n${offenders.join('\n')}`).toEqual([]);  });

  it('keeps interactive elements out of a CollapsibleSection label (#9165)', () => {
    // The label renders inside the header <button>; a link or button there is
    // nested-interactive (WCAG 4.1.2). It belongs in `headerActions`.
    const offenders = [];
    const interactiveIn = (label) => /<(Link|NavLink|a|button)[\s/>]/.test(label ?? '');
    expect(interactiveIn('<span><Link to="/x">go</Link></span>')).toBe(true);
    expect(interactiveIn('<span><a href="/x">go</a></span>')).toBe(true);
    expect(interactiveIn('<span>plain <b>text</b></span>')).toBe(false);
    for (const file of trackedJsxFiles()) {
      const src = maskedSourceOf(file);
      for (const node of forEachOpeningTag(src, 'CollapsibleSection')) {
        if (interactiveIn(attributeValue(node.tag, 'label'))) offenders.push(`${file}:${lineOf(src, node.index)}`);
      }
    }
    expect(offenders, `Interactive element inside a CollapsibleSection label — pass it as headerActions so it sits beside the toggle button, not inside it:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every Layout-free top-level route its own <main id="main-content"> (#18286)', () => {
    // Routes declared before the `<Route path="/" element={<Layout />}>` parent
    // skip PageShell, so their page component must render the landmark itself.
    const app = maskedSourceOf('src/App.jsx');
    const layoutAt = app.search(/<Route\s+path="\/"\s+element=\{<Layout\s*\/>\}/);
    expect(layoutAt, 'App.jsx no longer declares the Layout parent route').toBeGreaterThan(0);
    const components = [...app.slice(0, layoutAt).matchAll(/<Route\s+path="[^"]+"\s+element=\{<(\w+)\s*\/>\}/g)].map((m) => m[1]);
    expect(components.length).toBeGreaterThan(0);
    const importPath = (name) => app.match(new RegExp(`const ${name} = lazyWithReload\\(\\(\\) => import\\('\\./([^']+)'\\)\\)`))?.[1];
    const offenders = [];
    for (const name of components) {
      const rel = importPath(name);
      const file = rel && `src/${rel}.jsx`;
      if (!file) { offenders.push(`${name}: not a lazyWithReload import in App.jsx`); continue; }
      const src = maskedSourceOf(file);
      const ownsMain = [...forEachOpeningTag(src, 'main')].some((node) => /id=["']main-content["']/.test(node.tag));
      if (!ownsMain) offenders.push(`${file} (<${name} />)`);
      if (!LAYOUT_FREE_MAIN_FILES.includes(file)) offenders.push(`${file} missing from the nested-<main> allowlist`);
    }
    expect(offenders, `Layout-free route without <main id="main-content"> (WCAG 1.3.1, 2.4.1):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('renders exactly one <main> landmark — the app shell owns it (#9163)', () => {
    // PageShell.jsx renders the skip-link target <main id="main-content"> for
    // every Layout route; a page rendering its own <main> nests a second
    // landmark inside it (WCAG 1.3.1). Layout-free entry pages own their <main>.
    const OWN_MAIN = new Set(LAYOUT_FREE_MAIN_FILES);
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      if (OWN_MAIN.has(file.replace(/^.*?(src\/)/, '$1'))) continue;
      const src = maskedSourceOf(file);
      for (const node of forEachOpeningTag(src, 'main')) offenders.push(`${file}:${lineOf(src, node.index)}`);
    }
    expect(offenders, `Nested <main> — use <section> (the app shell's <main id="main-content"> is the only landmark):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('floors editable field text at 16px on a coarse pointer, unlayered (#15177)', () => {
    // iOS Safari zooms on focus of any field under 16px, and fields carry their
    // own `text-sm`/`text-xs`. The floor must sit at the top level of the
    // stylesheet: Tailwind's `text-sm` lives in `@layer utilities`, so the same
    // rule inside any `@layer` would lose to it and silently do nothing.
    const css = readText(join(CLIENT_ROOT, 'src/index.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    const topLevel = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '{') {
        if (depth === 0) start = css.lastIndexOf('}', i) + 1;
        depth++;
      } else if (css[i] === '}') {
        depth--;
        if (depth === 0) topLevel.push(css.slice(start, i + 1));
      }
    }
    const rule = topLevel.find((block) => /^\s*@media\s*\(pointer:\s*coarse\)/.test(block) && /\btextarea\b/.test(block));
    expect(rule, 'src/index.css needs a top-level (unlayered) @media (pointer: coarse) rule setting font-size: 16px on input/select/textarea').toBeTruthy();
    expect(rule).toMatch(/font-size:\s*16px/);
    expect(rule).toMatch(/\bselect\b/);
    for (const type of ['checkbox', 'radio', 'range', 'color', 'file', 'hidden']) {
      expect(rule, `${type} inputs must be excluded`).toContain(`[type="${type}"]`);
    }
  });

  it('gives a text-[10px] button a coarse-pointer touch height (#15180)', () => {
    // A 10px label with tight padding renders a ~21px button; on a phone that
    // is a mis-tap hazard. Dense desktop chips stay compact via
    // `pointer-coarse:min-h-11`.
    const offendersIn = (file, src) => {
      const out = [];
      for (const node of forEachOpeningTag(src, 'button')) {
        const tokens = node.tag.split(/[\s"'`{}=]+/);
        // Any variant of a 10px label counts (`max-sm:`, `!`), so none escapes the scan.
        if (!tokens.some((t) => /(?:^|[:!])text-\[10px\]$/.test(t))) continue;
        const px = (v) => (/^\d+$/.test(v) ? Number(v) * 4 : /^\[(\d+)px\]$/.test(v) ? Number(/\d+/.exec(v)[0]) : /^\[(\d+(?:\.\d+)?)rem\]$/.test(v) ? parseFloat(v.slice(1)) * 16 : 0);
        // Only an unprefixed floor (always) or a bare/`any-` pointer-coarse floor satisfies it.
        const tall = tokens.some((t) => {
          const m = /^(?:(?:any-)?pointer-coarse:)?(?:min-)?h-(.+)$/.exec(t);
          return m && px(m[1]) >= 44;
        });
        if (tall) continue;
        out.push(`${file}:${lineOf(src, node.index)}`);
      }
      return out;
    };
    expect(offendersIn('probe.jsx', '<button className="px-1.5 py-0.5 text-[10px]">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="px-1.5 pointer-coarse:min-h-11 text-[10px]">x</button>')).toEqual([]);
    expect(offendersIn('probe.jsx', '<button className="max-sm:text-[10px] !text-[10px]">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="text-[10px] max-sm:pointer-coarse:min-h-11">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="text-[10px] not-pointer-coarse:min-h-11">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="text-[10px] min-h-[56px]">x</button>')).toEqual([]);
    const offenders = [];
    for (const file of trackedJsxFiles()) offenders.push(...offendersIn(file, rawSourceOf(file)));
    expect(offenders, `<button> with text-[10px] needs pointer-coarse:min-h-11:\n${offenders.join('\n')}`).toEqual([]);
  });
});
