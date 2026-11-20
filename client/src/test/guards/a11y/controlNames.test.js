/**
 * Accessibility conventions: accessible names for controls and clickable elements.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { trackedJsxFiles, maskedSourceOf, rawSourceOf, openingTagAt, forEachOpeningTag, lineOf, isUnnamedIconOnlyButton } from '../../a11yScanCore.js';
import { maskComments, isResponsiveHiddenOnlyLabelControl, } from '../../a11yScanNames.js';
import { hasCallerSuppliedName } from '../../a11yScanWrappers.js';
import { mouseOnlyClickables, unnamedControlAnchors, CONTROL_NAME_RULES, isNamed, namesId } from '../../a11yScanRules.js';

describe('a11y conventions: controlNames', () => {
  it('gives every icon-only button an accessible name', () => {
    // A <button> whose entire body is an icon (including one chosen by a
    // ternary, e.g. play/pause, expand/collapse) has no text content for a
    // screen reader to announce. `title` alone doesn't fill that gap — it's
    // mouse-hover-only (no touch discoverability, and this app is opened from
    // other devices over the tailnet) and browser/AT support for `title` as
    // the accessible name is inconsistent. aria-label (or aria-labelledby) is
    // required; media/MediaCard.jsx's Annotate button (title + a paired
    // aria-label) is the existing convention.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = rawSourceOf(file);
      if (!src.includes('<button')) continue;
      for (const node of forEachOpeningTag(src, 'button')) {
        if (!isUnnamedIconOnlyButton(src, node)) continue;
        offenders.push(`${file}:${lineOf(src, node.index)}`);
      }
    }
    expect(offenders, `Icon-only <button> with no aria-label/aria-labelledby — title alone isn't touch-discoverable and isn't reliably read as the accessible name; see media/MediaCard.jsx's Annotate button for the convention:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps a responsive-hidden control label in the accessible name', () => {
    // A <button>/<a>/<Link> whose only text sits inside a `hidden
    // sm:inline`/`hidden @xs:inline` span loses its name exactly where that
    // wrapper hides it, because `display:none` content is excluded from
    // accessible-name computation. Convert to `max-<bp>:sr-only` /
    // `@max-<size>:sr-only` (ui/TabPills.jsx:172 is the existing convention)
    // so the label stays in the tree and is hidden only visually.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = rawSourceOf(file);
      for (const tagName of ['button', 'a', 'Link']) {
        if (!src.includes(`<${tagName}`)) continue;
        for (const node of forEachOpeningTag(src, tagName)) {
          if (!isResponsiveHiddenOnlyLabelControl(src, node)) continue;
          offenders.push(`${file}:${lineOf(src, node.index)}`);
        }
      }
    }
    expect(offenders, `<button>/<a>/<Link> whose only accessible name is inside a "hidden <bp>:inline" (or "@<size>:…") span — convert to "max-<bp>:sr-only" / "@max-<size>:sr-only" so the label survives at every width (see ui/TabPills.jsx:172):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('flags the hidden-label shape and passes the sr-only fix (#8118)', () => {
    const failing = '<button><X /><span className="hidden sm:inline">Save</span></button>';
    const [failingNode] = [...forEachOpeningTag(failing, 'button')];
    expect(isResponsiveHiddenOnlyLabelControl(failing, failingNode)).toBe(true);

    const passing = '<button><X /><span className="max-sm:sr-only">Save</span></button>';
    const [passingNode] = [...forEachOpeningTag(passing, 'button')];
    expect(isResponsiveHiddenOnlyLabelControl(passing, passingNode)).toBe(false);

    // A control that also carries always-visible text keeps a name at every
    // width, so it is not this bug (Catalog.jsx's `Remix<span className=
    // "hidden sm:inline"> into…</span>`).
    const mixedVisible = '<button>Remix<span className="hidden sm:inline"> into…</span></button>';
    const [mixedNode] = [...forEachOpeningTag(mixedVisible, 'button')];
    expect(isResponsiveHiddenOnlyLabelControl(mixedVisible, mixedNode)).toBe(false);

    // A real aria-label exempts the control even though the text is hidden
    // the same way.
    const labeled = '<button aria-label="Save"><X /><span className="hidden sm:inline">Save</span></button>';
    const [labeledNode] = [...forEachOpeningTag(labeled, 'button')];
    expect(isResponsiveHiddenOnlyLabelControl(labeled, labeledNode)).toBe(false);

    // A genuinely icon-only button (no text at all) is left to
    // `isUnnamedIconOnlyButton`, not double-flagged here.
    const iconOnly = '<button><X /></button>';
    const [iconOnlyNode] = [...forEachOpeningTag(iconOnly, 'button')];
    expect(isResponsiveHiddenOnlyLabelControl(iconOnly, iconOnlyNode)).toBe(false);

    // The container-query variant follows the same rule.
    const containerFailing = '<a href="/x"><X /><span className="hidden @xs:inline">Details</span></a>';
    const [containerNode] = [...forEachOpeningTag(containerFailing, 'a')];
    expect(isResponsiveHiddenOnlyLabelControl(containerFailing, containerNode)).toBe(true);
  });

  it('keyboard-activates every clickable non-interactive element', () => {
    // Whole-tree scan (every tracked JSX file), so a contended full-suite
    // worker can exceed the default 5s budget — runner budget, not product
    // behavior. The assertion itself is unaffected by the timeout value.
    // A mouse-only `onClick` on a <div>/<li>/<tr> is the most common way an
    // otherwise-accessible view loses its keyboard users: the element never
    // enters the tab order, so there is no keystroke that reaches the handler
    // at all. Spread `clickableProps(handler)` from lib/a11yKeyboard.js
    // alongside the existing onClick (components/IngredientPicker.jsx is the
    // worked example) — or, for a surface with its own ARIA role, write
    // role + tabIndex + onKeyDown out in full.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      // Masking only removes text, so no `onClick` in the raw source means none
      // in the masked source; skip the per-character comment lexer.
      if (!rawSourceOf(file).includes('onClick')) continue;
      const src = maskedSourceOf(file);
      for (const { name, index } of mouseOnlyClickables(src)) {
        offenders.push(`${file}:${lineOf(src, index)} <${name}>`);
      }
    }
    expect(offenders, `Non-interactive element with a mouse-only onClick — spread {...clickableProps(handler)} from lib/a11yKeyboard.js (see IngredientPicker.jsx), or write role + tabIndex + onKeyDown in full:\n${offenders.join('\n')}`).toEqual([]);
  }, 60_000);

  it('reads activation off the tag itself, and not out of a comment', () => {
    // The rule above is green against the whole tree, so nothing in the tree
    // pins what it actually rejects. These fixtures do: one probe per branch,
    // so it cannot go vacuously green.
    const clickables = (src) => [...mouseOnlyClickables(src)].map(({ name }) => name);

    expect(clickables('<div onClick={select}>Pick</div>')).toEqual(['div']);
    expect(clickables('<div onClick={select} {...clickableProps(select)}>Pick</div>')).toEqual([]);
    expect(clickables('<li onClick={select} role="option" tabIndex={0} onKeyDown={onKey}>Pick</li>')).toEqual([]);
    expect(clickables('<div onClick={e => e.stopPropagation()}><GripVertical /></div>')).toEqual([]);
    // The same shim hoisted to a named const — resolved out of the source, not
    // pattern-matched off the tag, so `onClick={stopNodeActivation}` is not read
    // as a real clickable.
    expect(clickables('const stop = (event) => event.stopPropagation();\n<div onClick={stop}><Grip /></div>')).toEqual([]);
    // …but a named handler that is NOT a shim stays reported, or the branch
    // above would exempt every clickable that hoists its handler.
    expect(clickables('const stop = (event) => onSelect(event);\n<div onClick={stop}>Pick</div>')).toEqual(['div']);
    // A scrim is outside the a11y tree and dismissed with Esc by its owner;
    // giving it a tab stop would put focus on an element AT is told to ignore.
    expect(clickables('<div className="fixed inset-0" onClick={close} aria-hidden="true" />')).toEqual([]);
    // A composite-widget row is focus-managed by its parent (ARIA APG), and a
    // click-to-dismiss dialog surface closes on Esc.
    expect(clickables('<div onClick={dispatch} role="option" aria-selected={focused}>Go</div>')).toEqual([]);
    expect(clickables('<div role="dialog" aria-modal="true" onClick={onClose}>…</div>')).toEqual([]);
    // A partial triple is not the escape hatch — a role with no tab stop is
    // announced as a button the keyboard can never reach.
    expect(clickables('<div onClick={select} role="button">Pick</div>')).toEqual(['div']);
    // …and neither is a full triple whose tab stop is programmatic-focus-only.
    expect(clickables('<div onClick={select} role="button" tabIndex={-1} onKeyDown={onKey}>Pick</div>')).toEqual(['div']);
    // A <button> activates itself; reporting one would make the rule noise.
    expect(clickables('<button onClick={select}>Pick</button>')).toEqual([]);

    // Every exemption is read off attribute NAMES and SPREAD expressions, never
    // off the raw tag text, so nothing quoted can forge one. Without this the
    // rule is one stray string away from exempting the elements it exists
    // for — and the string would be invisible in review.
    expect(clickables('<div onClick={select} title="clickableProps(select)">Pick</div>')).toEqual(['div']);
    // Nor can building the props without spreading them onto the element.
    expect(clickables('<div onClick={() => clickableProps(select)}>Pick</div>')).toEqual(['div']);
    expect(clickables('<div onClick={select} title=" role= tabIndex= onKeyDown=">Pick</div>')).toEqual(['div']);
    // A name declared twice resolves to no shim: one component's
    // `e.stopPropagation()` must not exempt another's real handler.
    expect(clickables('const stop = (e) => e.stopPropagation();\nconst stop = (e) => onSelect(e);\n<div onClick={stop}>Pick</div>')).toEqual(['div']);

    // The rule reads MASKED source, so a JSX example written in a comment —
    // the shape lib/a11yKeyboard.js's own usage docblock is written in — cannot
    // fail the suite.
    expect(clickables(maskComments('// <div onClick={select}>Pick</div>'))).toEqual([]);
  });

  for (const { tag, listName, allowlist, issue, remedy } of CONTROL_NAME_RULES) {
    it(`gives every <${tag}> an accessible name`, () => {
      // A control with no name is announced as bare "edit text" / "combo box",
      // and a link with no name as bare "link". Prefer the name the element
      // already renders — a paired `<label htmlFor>`, or the anchor's own text;
      // aria-label is for the compact rows (peer management, inline filters,
      // icon-only action links) where visible text breaks the layout.
      const offenders = [...unnamedControlAnchors(tag)].filter((anchor) => !allowlist?.has(anchor));
      expect(offenders, `<${tag}> without an accessible name — ${remedy}:\n${offenders.join('\n')}`).toEqual([]);
    });

    if (allowlist) it(`keeps no stale <${tag}> entries in ${listName} (${issue})`, () => {
      // The allowlists only shrink. An entry whose control has since been named —
      // or deleted, or renamed so its anchor no longer resolves — is dead weight
      // that quietly re-exempts the next control to land on that same anchor.
      // Fail on it so the burn-down stays honest instead of drifting. A shared
      // allowlist is filtered to this tag's own rows (field 2 of the anchor) so
      // the <select> pass can't call a live <textarea> row stale.
      const unnamed = unnamedControlAnchors(tag);
      const stale = [...allowlist].filter((entry) => entry.split('|')[1] === tag && !unnamed.has(entry));
      expect(stale, `${listName} entries that no longer match an unnamed <${tag}> — delete them:\n${stale.join('\n')}`).toEqual([]);
    });
  }

  it('reads a name for <select>/<textarea> from every escape hatch, and from nothing else', () => {
    // The rules above are only honest if the recognizer really rejects a bare
    // control. Probe each direction on the two tags #4309 added: without this
    // the whole widening could be vacuous (every control "named", allowlist
    // never shrinking because nothing was ever unnamed).
    expect(isNamed('<select value={sort}><option>a</option></select>', 'select')).toBe(false);
    expect(isNamed('<textarea value={notes} rows={3} />', 'textarea')).toBe(false);

    expect(isNamed('<select aria-label="Sort by" value={sort} />', 'select')).toBe(true);
    expect(isNamed('<select aria-label={false} value={sort} />', 'select')).toBe(false);
    expect(isNamed('<select aria-label={true} value={sort} />', 'select')).toBe(false);
    expect(isNamed('<label htmlFor="sort">Sort by</label>\n<select id="sort" />', 'select')).toBe(true);
    expect(isNamed('<label>Sort by<select value={sort} /></label>', 'select')).toBe(true);
    expect(isNamed('<span id="notes-h">Notes</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);
    expect(isNamed("import FormField from '../ui/FormField';\n<FormField label=\"Notes\"><textarea value={notes} /></FormField>", 'textarea')).toBe(true);
    expect(isNamed('function Field({ label, children }) {\n  return (<label className="block"><span>{label}</span>{children}</label>);\n}\n<Field label="Sort by"><select value={sort} /></Field>', 'select')).toBe(true);

    // `type` names an <input> and nothing else. A `type` attribute on the other
    // two tags is meaningless markup, and reading it as a name would exempt
    // them wholesale — the widest bypass this change could have introduced.
    expect(isNamed('<input type="hidden" value={token} />', 'input')).toBe(true);
    expect(isNamed('<select type="hidden" value={sort} />', 'select')).toBe(false);
    expect(isNamed('<textarea type="submit" value="Send" />', 'textarea')).toBe(false);
  });

  it('reads a name for <a> from its own content, and from nothing else', () => {
    // The <a> rule (#5674) rests on a recognizer no other tag uses: a link
    // names itself from what it renders. Both directions have to be pinned or
    // the rule goes vacuous in whichever one drifts — credit everything and it
    // never reports the icon-only links it exists for; credit nothing and it
    // floods with every ordinary text link in the tree, which is the failure
    // that would get it deleted.
    expect(isNamed('<a href={url}>Open in Jira</a>', 'a')).toBe(true);
    expect(isNamed('<a href={url}>{label}</a>', 'a')).toBe(true);
    expect(isNamed('<a href={url} aria-label="Download"><Download size={14} /></a>', 'a')).toBe(true);
    expect(isNamed('<a href={url} title="Download"><Download size={14} /></a>', 'a')).toBe(false);
    expect(isNamed('<a href={url}><Download size={14} /></a>', 'a')).toBe(false);

    // `title` is a hover affordance, not the accessible name — the same reason
    // the icon-only-button rule refuses it. Asserted rather than assumed,
    // because seven of the eight anchors #5674 named already carried one, and a
    // recognizer that credited `title` would have reported none of them.
    expect(isNamed('<a href={url} title="Open on Civitai"><ExternalLink /></a>', 'a')).toBe(false);

    // A thumbnail link is named by its image's alt — bolting an aria-label onto
    // one would OVERRIDE that alt, so crediting it is what keeps the rule from
    // driving a regression. An empty/absent alt names nothing.
    expect(isNamed('<a href={url}><img src={src} alt={caption} /></a>', 'a')).toBe(true);
    expect(isNamed('<a href={url}><img src={src} alt="Cover art" /></a>', 'a')).toBe(true);
    expect(isNamed('<a href={url}><img src={src} alt="" /></a>', 'a')).toBe(false);
    expect(isNamed('<a href={url}><img src={src} /></a>', 'a')).toBe(false);

    // …but only where HTML says `alt` names anything. On a <div> the browser
    // ignores it outright, and on a component nothing proves it is forwarded to
    // an image — crediting either would exempt an unnamed link on the strength
    // of inert markup.
    expect(isNamed('<a href={url}><div alt="Cover art" /></a>', 'a')).toBe(false);
    expect(isNamed('<a href={url}><Thumb alt="Cover art" /></a>', 'a')).toBe(false);

    // An anchor wrapping a component THIS FILE declares is named by what that
    // component renders, so an aria-label here would replace a whole card's
    // text with a terser name. The discriminator is text, not componentness:
    // every link this rule exists to catch wraps an imported icon, and a
    // file-local icon wrapper is credited no more than an imported one.
    const localCard = 'function Card({ t }) {\n  return (<div><span>{t.key}</span></div>);\n}\n';
    const localIcon = 'function IconOnly() {\n  return (<Download size={14} />);\n}\n';
    expect(isNamed(`${localCard}<a href={url}><Card t={t} /></a>`, 'a')).toBe(true);
    expect(isNamed(`${localIcon}<a href={url}><IconOnly /></a>`, 'a')).toBe(false);

    // An aria-hidden child is removed from the name computation, so an anchor
    // whose ONLY content is hidden computes an empty name — worse than the
    // title-only shape, and invisible to a check that merely asked "does this
    // anchor have children".
    expect(isNamed('<a href={url} title="Open board"><ExternalLink aria-hidden="true" /></a>', 'a')).toBe(false);
    expect(isNamed('<a href={url}><img src={src} alt="Cover" aria-hidden="true" /></a>', 'a')).toBe(false);
    expect(isNamed('<a href={url}><span aria-hidden="true">→</span>Next page</a>', 'a')).toBe(true);
  });

  it('masks JSX examples written in comments after an expression-rendered list', () => {
    // maskComments exists so a `<select>` mentioned in prose isn't scanned as
    // markup. One shape stranded it: an element rendered from inside an
    // expression (`{options.map(…)}`), whose own `{o.label}` closed the
    // enclosing expression's braces. The following `</select>` then read as a
    // less-than and never popped, so the file finished one element deep — and
    // in `jsx-text` mode `//` no longer starts a comment, which made every
    // later prose mention of a control scan as real markup. PipelineSeries.jsx
    // is the live instance: a comment describing its labeled <select> showed up
    // as an unnamed control 500 lines below the expression that broke the lexer.
    const listThenProse = `function Picker({ options }) {
  return (
    <div>
      <select value={value} onChange={onChange}>
        {options.map((o) => <option key={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

// A blank-first labeled <select> lives in SgSelect — prose, not markup.
`;
    const masked = maskComments(listThenProse);
    expect(masked).toContain('<select value={value}');
    expect(masked.split('\n').at(-2)).not.toContain('<select>');
  });

  it('only credits an htmlFor-forwarding wrapper that really names the control', () => {
    // The rule above now accepts a page-local wrapper that renders the <label>
    // and takes the control's id as a prop. That is only a real name when the
    // wrapper does BOTH halves of the job, so probe the bypasses: a wrapper
    // that forwards the id onto a <label> holding no text names nothing, and a
    // call site that omits `label=` supplies no text either. Without these, the
    // recognizer degenerates into "any component with an htmlFor prop exempts
    // its input" — which would silently hide the exact gap the rule scans for.
    const forwarder = `function Group({ label, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block">{label}</label>
      {children}
    </div>
  );
}`;
    const emptyForwarder = forwarder.replace('{label}', '');
    const namedCall = `<Group label="Sleep" htmlFor="sleep-hours"><input id="sleep-hours" type="range" /></Group>`;
    const unnamedCall = `<Group htmlFor="sleep-hours"><input id="sleep-hours" type="range" /></Group>`;

    expect(namesId(`${forwarder}\n${namedCall}`, 'sleep-hours')).toBe(true);
    expect(namesId(`${forwarder}\n${unnamedCall}`, 'sleep-hours')).toBe(false);
    expect(namesId(`${emptyForwarder}\n${namedCall}`, 'sleep-hours')).toBe(false);
    // A different id on the same wrapper must not be swept up either.
    expect(namesId(`${forwarder}\n${namedCall}`, 'other-id')).toBe(false);
    // `label` with no value is `label={true}`, which renders no text.
    expect(namesId(`${forwarder}\n${namedCall.replace('label="Sleep"', 'label={true}')}`, 'sleep-hours')).toBe(false);
    // The scan masks comments before any of this runs, so a commented-out
    // wrapper must not register as one. Probe the source the way the scan
    // hands it over, or this helper looks safe for the wrong reason.
    const commentedForwarder = `function Group({ label, htmlFor, children }) {
  // <label htmlFor={htmlFor}>{label}</label>
  return <div>{children}</div>;
}`;
    expect(namesId(maskComments(`${commentedForwarder}\n${namedCall}`), 'sleep-hours')).toBe(false);

    // The forwarded prop does not have to be called `htmlFor` — StackerNews's
    // `Field({ id, label })` does the same job through `id`. Both halves stay
    // required, and the id must still be read from the prop the wrapper
    // actually forwards, not from any attribute that happens to be present.
    const idPropForwarder = forwarder.replace('label, htmlFor, children', 'id, label, children').replace('htmlFor={htmlFor}', 'htmlFor={id}');
    const idPropCall = `<Group id="sleep-hours" label="Sleep"><input id="sleep-hours" type="range" /></Group>`;
    expect(namesId(`${idPropForwarder}\n${idPropCall}`, 'sleep-hours')).toBe(true);
    expect(namesId(`${idPropForwarder}\n${idPropCall.replace(' label="Sleep"', '')}`, 'sleep-hours')).toBe(false);
    // `htmlFor=` on the call site is not the forwarded prop here, so it must
    // not stand in for the `id` this wrapper reads.
    expect(namesId(`${idPropForwarder}\n${idPropCall.replace('id="sleep-hours" label', 'htmlFor="sleep-hours" label')}`, 'sleep-hours')).toBe(false);

    // A forwarder can take its text as JSX children instead of a prop
    // (UniverseBibleTab's `<FieldLabel htmlFor="world-logline">Logline`). There
    // is no `children=` attribute to read at the call site, so the name has to
    // come from the element's own body — and an empty body still names nothing.
    const childrenForwarder = `function FieldLabel({ htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-xs">{children}</label>
    </div>
  );
}`;
    const childrenCall = '<FieldLabel htmlFor="sleep-hours">Sleep</FieldLabel>\n<input id="sleep-hours" type="range" />';
    expect(namesId(`${childrenForwarder}\n${childrenCall}`, 'sleep-hours')).toBe(true);
    expect(namesId(`${childrenForwarder}\n${childrenCall.replace('>Sleep<', '><')}`, 'sleep-hours')).toBe(false);
    expect(namesId(`${childrenForwarder}\n${childrenCall}`, 'other-id')).toBe(false);
  });

  it('credits a caller-supplied id only when every call site names it', () => {
    // The mirror of the wrapper probes above: here the reusable component IS
    // the control, and the <label> lives in the caller's file. The exemption is
    // only real when every call site does its half, so probe both bypasses — a
    // caller that passes the id and no label, and one that omits the id — plus
    // the "one bad call site spoils it" quantifier. Without these the rule
    // degenerates into "any component with an id prop is exempt", which would
    // hide the exact gap it scans for.
    const control = `export default function Combo({ inputId, value, onChange }) {
  return <input id={inputId} type="text" value={value} onChange={onChange} />;
}`;
    const site = (src, localName = 'Combo') => ({ src, localName, exportedName: 'default' });
    const credits = (...sites) => {
      const index = control.indexOf('<input');
      return hasCallerSuppliedName(control, openingTagAt(control, index), index, sites);
    };

    const labeled = '<label htmlFor="rounds">Rounds</label>\n<Combo inputId="rounds" value={v} />';
    const noLabel = '<Combo inputId="rounds" value={v} />';
    const noId = '<label htmlFor="rounds">Rounds</label>\n<Combo value={v} />';

    expect(credits(site(labeled))).toBe(true);
    expect(credits(site(noLabel))).toBe(false);
    expect(credits(site(noId))).toBe(false);
    // A label whose htmlFor points somewhere else names a different control.
    expect(credits(site(labeled.replace('htmlFor="rounds"', 'htmlFor="other"')))).toBe(false);
    // …and a <label> carrying no text names nothing, here as everywhere.
    expect(credits(site(labeled.replace('>Rounds<', '><')))).toBe(false);

    // Every call site, not any: the unlabeled screen is still unlabeled.
    expect(credits(site(labeled), site(noLabel))).toBe(false);
    expect(credits(site(labeled), site(labeled.replace(/rounds/g, 'laps')))).toBe(true);

    // A renamed default import is the same component, and must be read under
    // the local binding the caller actually renders.
    expect(credits(site(labeled.replace(/Combo/g, 'Wrapped'), 'Wrapped'))).toBe(true);
    // A site importing a DIFFERENT export of the same file proves nothing about
    // this component, so it is neither credited nor counted against it.
    expect(credits({ ...site(labeled), exportedName: 'Other' })).toBe(false);
    // No call site at all is not proof of a name — an unrendered control cannot
    // borrow one from a caller that does not exist.
    expect(credits()).toBe(false);

    // An UNREADABLE call site is a `false`, not a skipped one. This is the
    // reason the shared walk yields unterminated tags instead of deciding for
    // its callers (#4341): every other walk wants "which tags are there" and
    // drops it, this one asks "did every call site do its half" and cannot.
    const unterminated = '<label htmlFor="rounds">Rounds</label>\n<Combo inputId="rounds"';
    expect(credits(site(unterminated))).toBe(false);
    expect(credits(site(labeled), site(unterminated))).toBe(false);

    // The id has to be CALLER-supplied. A locally generated one is not the
    // caller's to name — `<Combo inputId="rounds">` would then exempt an input
    // whose id the caller never saw — so a non-parameter id is not this shape.
    const localId = `export default function Combo({ value, onChange }) {
  const inputId = useId();
  return <input id={inputId} type="text" value={value} onChange={onChange} />;
}`;
    const localIndex = localId.indexOf('<input');
    expect(hasCallerSuppliedName(localId, openingTagAt(localId, localIndex), localIndex, [site(labeled)])).toBe(false);

    // …and the id has to be the control's OWN. A same-named prop on another
    // attribute (`data-id={inputId}`) never reaches the a11y tree.
    const dataId = control.replace('id={inputId}', 'data-id={inputId}');
    const dataIndex = dataId.indexOf('<input');
    expect(hasCallerSuppliedName(dataId, openingTagAt(dataId, dataIndex), dataIndex, [site(labeled)])).toBe(false);
  });

  it('credits a FormField whose only child is a conditional, but not a list', () => {
    // A FormField's child is frequently a ternary rather than the control
    // itself (`{isSelect ? <select/> : <input/>}`); React clones the generated
    // id onto whichever branch renders, so the control really is named. The
    // veto that matters is a rendered LIST — Children.map flattens it and
    // clones only the first element, so crediting each control in a `.map()`
    // would exempt every one after the first.
    // The wrapper is credited only once its own source has been read, so every
    // fixture carries the import a real call site would.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Rounds">\n  ${child}\n</FormField>`;
    const credits = (src, tagName = 'input') => isNamed(src, tagName);

    const ternary = field(`{isSelect ? (<select><option>a</option></select>) : (<input type="number" />)}`);
    expect(credits(ternary)).toBe(true);

    // A `.map()` in the OTHER branch has already closed by the time the control
    // is reached, so it must not disqualify the shape.
    const ternaryWithListedOptions = field(`{isSelect ? (<select>{opts.map((o) => (<option key={o}>{o}</option>))}</select>) : (<input type="number" />)}`);
    expect(credits(ternaryWithListedOptions)).toBe(true);

    const list = field(`{fields.map((f) => (<input key={f} type="number" />))}`);
    expect(credits(list)).toBe(false);

    // A sibling that happens to BE an <input> must not stand in for the
    // "control is the first child" marker — the second control is not cloned,
    // so a <select> after an <input> is still unnamed.
    const afterInput = field('<input type="text" />\n  <select><option>a</option></select>');
    expect(credits(afterInput, 'select')).toBe(false);

    // Only the element the expression yields directly is cloned; a control
    // nested inside a wrapper element gets no id.
    const wrapped = field(`{isSelect ? (<select />) : (<div><input type="number" /></div>)}`);
    expect(credits(wrapped)).toBe(false);

    // An unlabeled FormField names nothing, whatever its child looks like.
    const unlabeled = ternary.replace(' label="Rounds"', '');
    expect(credits(unlabeled)).toBe(false);

    // The registry never trusts a component by name — a same-named wrapper
    // imported from somewhere else is a different component, and crediting it
    // on the strength of the identifier `FormField` would be the widest
    // exemption the guard grants. Here the specifier resolves to nothing, so
    // there is no source to read and no shape to credit.
    const foreign = ternary.replace("from '../ui/FormField'", "from './LocalFormField'");
    expect(credits(foreign)).toBe(false);
    // Same for a locally-declared `FormField` that is not a cloning wrapper.
    const shadowed = `function FormField({ label, children }) {\n  return <div>{label}{children}</div>;\n}\n${ternary.replace(/^import[^\n]*\n/, '')}`;
    expect(credits(shadowed)).toBe(false);
  });

  it('shares one open-wrapper scanner between the implicit and cloned matchers (#4328)', () => {
    // Both ancestor-based shapes ask `openWrapperInstancesAt` the same question,
    // so both DIRECTIONS of it need pinning — and through BOTH matchers, or the
    // fold that stopped the two from drifting is witnessed on one path only.
    const implicitWrapper = 'const Field = ({ label, children }) => (\n  <label className="block"><span>{label}</span>{children}</label>\n);\n';
    const clonedWrapper = "import FormField from '../ui/FormField';\n";

    // A wrapper that has already CLOSED names nothing after it. The control has
    // to be the first thing following the close: with a preceding sibling the
    // cloned path would reject it via the first-direct-child walk instead, for
    // a reason that has nothing to do with openness.
    const afterClose = (wrapper, name) => `${wrapper}<${name} label="Rounds"></${name}>\n<select><option>a</option></select>`;
    expect(isNamed(afterClose(implicitWrapper, 'Field'), 'select')).toBe(false);
    expect(isNamed(afterClose(clonedWrapper, 'FormField'), 'select')).toBe(false);

    // An inner labeled wrapper nested in an unlabeled outer one still names its
    // own first child — the reason the scanner keeps EVERY open instance rather
    // than just the outermost.
    const nested = (wrapper, name) => `${wrapper}<${name}>\n  <${name} label="Rounds">\n    <select><option>a</option></select>\n  </${name}>\n</${name}>`;
    expect(isNamed(nested(implicitWrapper, 'Field'), 'select')).toBe(true);
    expect(isNamed(nested(clonedWrapper, 'FormField'), 'select')).toBe(true);
  });

  it('never reads markup out of an attribute value (#4337)', () => {
    // Each scanner used to re-derive a `re.lastIndex = contentStart` advance to
    // keep its walk out of the tag it had just read — and one of them
    // (`hasMatchingLabelElement`) never had it, so it matched markup written in
    // an attribute VALUE as an element. That is a false POSITIVE in a guard: a
    // control with no label of its own is credited by label-shaped prose
    // belonging to some other element, and drops off the offender list
    // silently. #4341 retired the advance along with the regex walk — an
    // attribute value is a string token now, so no walk can enter one at all —
    // but the verdicts it protected are the same, and still pinned here.
    expect(isNamed('<label htmlFor="other" title=\'<label htmlFor="x">Rounds</label>\'>Other</label>\n<input id="x" type="text" />')).toBe(false);
    // The walk resumes at the opening tag's END, not past the whole ELEMENT, so
    // a real label nested in that tag's body is still found. Nesting it is what
    // makes this discriminate: a label written after `</label>` would be found
    // under either policy, so it would prove nothing.
    expect(isNamed('<label htmlFor="other" title=\'<label>\'>Other <label htmlFor="x">Rounds</label></label>\n<input id="x" type="text" />')).toBe(true);
  });

  it('credits a name written inside an attribute expression (#4341)', () => {
    // The boundary #4337 documented, now crossed. The regex walk's
    // `re.lastIndex = contentStart` advance stepped over a whole opening tag, so
    // an element written inside an attribute EXPRESSION was never visited and
    // `notes-h` never resolved. The scanner enters that expression the same way
    // React does, so the <span> really does render and really does name the
    // textarea.
    expect(isNamed('<Foo render={<span id="notes-h">Notes</span>} />\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);
    // The same id written as a real sibling element resolves too — the walk
    // gained a shape rather than trading one for another.
    expect(isNamed('<span id="notes-h">Notes</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);
    // What the advance actually existed to stop is still stopped, and by
    // construction now: markup in a quoted attribute VALUE is a string to the
    // scanner, so it names nothing.
    expect(isNamed('<Foo render=\'<span id="notes-h">Notes</span>\' />\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    // An id that resolves to an element carrying no text still names nothing,
    // wherever it is written — the descent widened which elements are seen, not
    // what counts as a name. An EMPTY expression body is one of those: it
    // renders nothing, and reading it as text credited a control with no name.
    expect(isNamed('<Foo render={<span id="notes-h" />} />\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    expect(isNamed('<span id="notes-h">{}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    expect(isNamed('<span id="notes-h">{/* todo */}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    // `{true}` renders nothing either — the sibling check on `label` props has
    // said so since it was written, and this one had drifted off it.
    expect(isNamed('<span id="notes-h">{true}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    // A non-empty expression is still text, or the fix would have swung past it.
    expect(isNamed('<span id="notes-h">{heading}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);

    // Descending into an expression must not make a wrapper opened INSIDE one
    // an ancestor of anything outside it: the nested `<Field label>` opens and
    // closes within `title={…}`, so the input is still nested only in the
    // UNLABELED outer wrapper and stays on the offender list.
    const field = 'function Field({ label, children }) {\n  return <label>{label}{children}</label>;\n}';
    expect(isNamed(`${field}\n<Field>\n<Header title={<Field label="Helper"><span>T</span></Field>} />\n<input id="x" type="text" />\n</Field>`)).toBe(false);
    // …and the labeled outer wrapper does name it, so the assertion above is
    // about where the label sits, not about the shape failing to parse.
    expect(isNamed(`${field}\n<Field label="Helper">\n<input id="x" type="text" />\n</Field>`)).toBe(true);
  });

  it('does not read a tag out of a comment (#4341)', () => {
    // The regex walk matched `<label` anywhere, comment text included, so a
    // commented-out label named a live control — a false NEGATIVE, the
    // direction that actually ships a bug. Masking hid it from the control scan
    // but not from the rules that read raw source. The scanner hands a comment
    // back as one span, so no walk can see into it, whether or not the caller
    // masked first.
    expect(isNamed('/* <label htmlFor="u">Commented</label> */\n<input id="u" type="text" />')).toBe(false);
    expect(isNamed('// <label htmlFor="u">Commented</label>\n<input id="u" type="text" />')).toBe(false);
    // The same label written as real markup names it, so this is about the
    // comment and not about the label going unread.
    expect(isNamed('<label htmlFor="u">Live</label>\n<input id="u" type="text" />')).toBe(true);
  });

  it('reads self-closing from the scanner, not off the end of the tag (#4341)', () => {
    // `tagEndAt` used to throw away `tagBoundaryAt`'s `selfClosing`, so four
    // callers re-derived it from the tag TEXT — and on UNMASKED source, which
    // two rules scan, a comment survives to the last two characters. Both
    // re-derivations then read a tag that has a body as self-closing and skip
    // it, which is a control dropping silently off the offender list.
    const commented = '<button /* pause */>{on ? <IconA /> : <IconB />}</button>';
    const [button] = [...forEachOpeningTag(commented, 'button')];
    expect(button.tag.endsWith('/>')).toBe(true); // what the rule used to ask
    expect(button.selfClosing).toBe(false); // what the scanner knows
    expect(isUnnamedIconOnlyButton(commented, button)).toBe(true);
    // The same shape through `hasUsableElementText`, whose re-derivation was the
    // `/\/\s*>$/` spelling: a commented <label> stops naming its input.
    expect(isNamed('<label htmlFor="rounds" /* which */ >Rounds</label>\n<input id="rounds" type="text" />')).toBe(true);

    // A genuinely self-closing tag still reads as one, or the fix would just
    // have moved the failure to the other direction.
    const [selfClosed] = [...forEachOpeningTag('<button />', 'button')];
    expect(selfClosed.selfClosing).toBe(true);
    expect(isUnnamedIconOnlyButton('<button />', selfClosed)).toBe(false);
    expect(isNamed('<label htmlFor="rounds" />\n<input id="rounds" type="text" />')).toBe(false);
  });

});
