/**
 * Accessibility conventions: a heading on every routed page, and heading levels
 * that never climb by more than one level on the way down.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { maskedSourceOf, forEachOpeningTag, renderedTagNames, tagIndexOf, lineOf, COMPONENT_TAG_NAME } from '../../a11yScanCore.js';
import { resolveRelativeImport, relativeImportBindings, reExportBindings, defaultExportName, withVirtualSources } from '../../a11yScanWrappers.js';
import { forEachLocalComponent } from '../../a11yScanNames.js';

describe('a11y conventions: routeHeadings', () => {
  // name -> { file, exportedName } for every component a `<Route element>` in
  // this source can name: the static relative imports, plus `lazyWithReload`
  // declarations — `const X = lazyWithReload(() => import('./pages/X'))`, and
  // the DevTools idiom `.then(m => ({ default: m.X }))`, which binds the page
  // under a NAMED export of the target module rather than `default`.
  const routeElementBindings = (appSrc, appFile) => {
    const bindings = relativeImportBindings(appSrc, appFile);
    const lazy = /const\s+([A-Z][\w$]*)\s*=\s*lazyWithReload\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*(?:\.then\(\s*\w+\s*=>\s*\(\s*\{\s*default\s*:\s*\w+\.([A-Z][\w$]*)\s*\}\s*\)\s*\))?/g;
    for (const m of appSrc.matchAll(lazy)) {
      const file = resolveRelativeImport(appFile, m[2]);
      if (file) bindings.set(m[1], { file, exportedName: m[3] ?? 'default' });
    }
    return bindings;
  };

  // `element={<X … />}` on a <Route> opening tag -> 'X'. Every element this
  // file writes is a single component element; the first name in the
  // expression is the component mounted.
  const routeElementName = (routeTag) => /\belement\s*=\s*\{\s*<\s*([A-Z][\w$.]*)/.exec(routeTag)?.[1] ?? null;

  // File -> does the component it exports under `exportedName` put a top-level
  // heading on the page? The file's own <h1>/<PageHeader> first — then the
  // barrel and thin-wrapper idioms. `depth` bounds the chase to a fixed nesting
  // and `seen` only dedupes file#export visits (and breaks forwarding cycles),
  // so the verdict never depends on how many sibling imports were walked first.
  const MAX_HEADING_CHASE_DEPTH = 8;
  const suppliesPageHeading = (file, exportedName, seen = new Set(), depth = 0) => {
    // Error boundaries own a recovery heading only while their children fail.
    // Crediting that heading to a layout exempts every healthy outlet page.
    if (/ErrorBoundary\.jsx$/.test(file)) return false;
    const key = `${file}#${exportedName}`;
    if (seen.has(key) || depth >= MAX_HEADING_CHASE_DEPTH) return false;
    seen.add(key);
    const src = maskedSourceOf(file);
    const rendered = renderedTagNames(src);
    if (rendered.has('h1') || rendered.has('PageHeader')) return true;
    const imports = routeElementBindings(src, file);
    // A file that imports the shared header counts even before its tag is
    // spelled out (#7245's rule) — and covers an aliased render of it.
    for (const { file: imported } of imports.values()) {
      if (/(^|\/)PageHeader\.jsx$/.test(imported)) return true;
    }
    const forwarded = reExportBindings(src, file).get(exportedName);
    if (forwarded && suppliesPageHeading(forwarded.file, forwarded.exportedName, seen, depth + 1)) return true;
    // A thin page that mounts an imported component carrying the heading —
    // Agents mounts AgentList — satisfies the route without writing its own.
    for (const [local, binding] of imports) {
      if (rendered.has(local) && suppliesPageHeading(binding.file, binding.exportedName, seen, depth + 1)) return true;
    }
    return false;
  };

  // Every <Route> element in `appFile` that resolves to a tracked file,
  // deduped by module+export, each carrying whether an ancestor <Route>'s
  // element already supplies the heading (a tab shell like MediaGen owns it
  // for the pages mounted in its outlet).
  const routedPageElements = (appFile) => {
    const appSrc = maskedSourceOf(appFile);
    const bindings = routeElementBindings(appSrc, appFile);
    const shelledByHeading = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (p.name !== 'Route' || p.tag === null) continue;
        const name = routeElementName(p.tag);
        const binding = name && bindings.get(name);
        if (binding && suppliesPageHeading(binding.file, binding.exportedName)) return true;
      }
      return false;
    };
    const elements = new Map();
    for (const node of forEachOpeningTag(appSrc, 'Route')) {
      const name = routeElementName(node.tag);
      if (!name) continue;
      const binding = bindings.get(name);
      // A name with no import binding renders no page of its own — Navigate,
      // and the local RedirectWithSearch/PrefixRedirect helpers.
      if (!binding) continue;
      const key = `${binding.file}#${binding.exportedName}`;
      const shelled = shelledByHeading(node);
      const prev = elements.get(key);
      // First-write-wins is wrong here: a file mounted both under a heading
      // shell and bare keeps the bare verdict, so the exemption can only ever
      // narrow to a mount that really sits under an h1.
      if (!prev) elements.set(key, { ...binding, elementName: name, shelled });
      else if (prev.shelled) prev.shelled = shelled;
    }
    return [...elements.values()];
  };

  const HEADINGLESS_ROUTE_ELEMENTS = new Set([
    'src/components/Layout.jsx',    // the app chrome — <Outlet/> children own the page h1
    'src/components/PageShell.jsx', // the <main> shells — <Outlet/> children own the page h1
    'src/pages/IMessage.jsx',       // redirect-only: renders <Navigate> to /messages/imessage
    'src/pages/SyncView.jsx',       // deep link that mounts SyncDetailDrawer over the prior page
  ]);

  const ROUTE_HEADING_GAP_ALLOWLIST = new Set([
    'src/pages/MoodBoardDetail.jsx',
    'src/pages/UniverseBuilder.jsx',
  ]);

  it('gives every routed page a top-level heading (#7245)', () => {
    // Probe first — the tree is green, so nothing in it pins what the walk
    // rejects, and a silent change of shape would turn the rule vacuous.
    const wideFillers = Array.from({ length: 10 }, (_, i) => `ProbeFiller${i}`);
    withVirtualSources({
      'src/ProbeApp.jsx': `
        import { Routes, Route, Navigate } from 'react-router';
        import Good from './pages/ProbeGood';
        import Bad from './pages/ProbeBad';
        import Thin from './pages/ProbeThin';
        import Barrel from './pages/ProbeBarrel';
        import Shell from './pages/ProbeShell';
        import ShellBare from './pages/ProbeShellBare';
        import Wide from './pages/ProbeWide';
        const LazyBad = lazyWithReload(() => import('./pages/ProbeLazyBad'));
        const LazyGood = lazyWithReload(() => import('./pages/ProbeLazyGood'));
        const LazyNamed = lazyWithReload(() => import('./pages/ProbeBarrel').then(m => ({ default: m.ProbeGood })));
        export default function ProbeApp() {
          return (
            <Routes>
              <Route path="/" element={<ShellBare />}>
                <Route index element={<Good />} />
                <Route path="bad" element={<Bad />} />
                <Route path="thin" element={<Thin />} />
                <Route path="wide" element={<Wide />} />
                <Route path="barrel" element={<Barrel />} />
                <Route path="lazy-bad" element={<LazyBad />} />
                <Route path="lazy-good" element={<LazyGood />} />
                <Route path="lazy-named" element={<LazyNamed />} />
                <Route path="away" element={<Navigate to="/" replace />} />
                <Route path="gone" element={<Unbound />} />
                <Route path="shelled" element={<Shell />}>
                  <Route path="kid" element={<Bad />} />
                </Route>
              </Route>
            </Routes>
          );
        }
      `,
      'src/pages/ProbeGood.jsx': 'export default function ProbeGood() { return <h1>Good</h1>; }',
      'src/pages/ProbeBad.jsx': 'export default function ProbeBad() { return <h2>Bad</h2>; }',
      'src/pages/ProbeThin.jsx': "import ProbeGood from './ProbeGood';\nexport default function ProbeThin() { return <ProbeGood />; }",
      // More heading-less rendered imports than the old shared visit budget
      // allowed, all ahead of the heading-bearing one.
      'src/pages/ProbeWide.jsx': `${wideFillers.map((n) => `import ${n} from '../components/${n}';`).join('\n')}\nimport ProbeGood from './ProbeGood';\nexport default function ProbeWide() { return <>${wideFillers.map((n) => `<${n} />`).join('')}<ProbeGood /></>; }`,
      ...Object.fromEntries(wideFillers.map((n) => [`src/components/${n}.jsx`, `export default function ${n}() { return <p>${n}</p>; }`])),
      'src/pages/ProbeBarrel.jsx': "export { default, default as ProbeGood } from './ProbeGood';",
      'src/pages/ProbeLazyBad.jsx': 'export default function ProbeLazyBad() { return <h2>Lazy</h2>; }',
      'src/pages/ProbeLazyGood.jsx': "import PageHeader from '../components/PageHeader';\nexport default function ProbeLazyGood() { return <PageHeader title=\"Lazy\" />; }",
      'src/pages/ProbeShell.jsx': 'export default function ProbeShell() { return <h1>Shell</h1>; }',
      'src/pages/ProbeShellBare.jsx': "import ProbeErrorBoundary from '../components/ProbeErrorBoundary';\nexport default function ProbeShellBare() { return <ProbeErrorBoundary><div /></ProbeErrorBoundary>; }",
      'src/components/ProbeErrorBoundary.jsx': 'export default function ProbeErrorBoundary({ children }) { return failed ? <h1>Recovery only</h1> : children; }',
    }, () => {
      const offenders = routedPageElements('src/ProbeApp.jsx')
        .filter((e) => !e.shelled)
        .filter((e) => !suppliesPageHeading(e.file, e.exportedName))
        .map((e) => e.file);
      // ShellBare (no heading of its own), Bad (h2 only), LazyBad — and NOT:
      // Good (h1), Thin (delegate owns the h1), Wide (the delegate owns it past
      // ten heading-less siblings), Barrel + LazyNamed (barrel
      // target owns it), LazyGood (PageHeader), Navigate/Unbound (no page),
      // and the Bad mounted under Shell's h1 outlet.
      expect(offenders).toEqual([
        'src/pages/ProbeShellBare.jsx',
        'src/pages/ProbeBad.jsx',
        'src/pages/ProbeLazyBad.jsx',
      ]);
    });

    const elements = routedPageElements('src/App.jsx');
    // Assert the walk really read the route table — a walker change that finds
    // no Route elements must not pass over an empty set.
    expect(elements.length, 'found no routed page elements in src/App.jsx — has the route table or its lazy-import idiom changed?').toBeGreaterThanOrEqual(90);

    const offenders = elements
      .filter((e) => !e.shelled)
      .filter((e) => !HEADINGLESS_ROUTE_ELEMENTS.has(e.file) && !ROUTE_HEADING_GAP_ALLOWLIST.has(e.file))
      .filter((e) => !suppliesPageHeading(e.file, e.exportedName))
      .map((e) => `${e.file} (route element <${e.elementName}>)`);
    expect(offenders, `Routed page renders no <h1> and no <PageHeader> — heading navigation opens below level 1 (WCAG 1.3.1/3.2.4). Give the page the shared PageHeader (or a direct <h1> where the surface is deliberately chromeless); a nested tab page under a heading shell gets a free pass only while the shell owns the h1:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps no stale entries in the routed-heading exemption lists (#7245)', () => {
    // The allowlists only shrink. An entry whose element was deleted/renamed —
    // or whose file now supplies a heading — is dead weight that quietly
    // re-exempts the next heading omission routed to that file.
    const routed = new Map(routedPageElements('src/App.jsx').map((e) => [e.file, e]));
    const stale = [...HEADINGLESS_ROUTE_ELEMENTS, ...ROUTE_HEADING_GAP_ALLOWLIST]
      .filter((file) => {
        const entry = routed.get(file);
        return entry === undefined || suppliesPageHeading(entry.file, entry.exportedName);
      });
    expect(stale, `routed-heading exemption entries that no longer match a heading-less routed element — delete them:\n${stale.join('\n')}`).toEqual([]);
  });

  // --- heading order (#17334) ----------------------------------------------
  // The outline of a routed page: the headings the page renders, in document
  // order. Only the page component's own JSX is walked — a heading inside a
  // lazy-loaded tab component (MeatSpace, Brain, DigitalTwin) is not seen,
  // because the tab bodies render behind a switch the walk cannot see through.
  // That is a known gap, not a pass: the eight routes in #17323 live in those
  // tabs and are covered by that issue's live sweep, not by this guard.
  const localComponentBodies = (src) => {
    const bodies = new Map();
    forEachLocalComponent(src, (name, text, _params, start) => {
      bodies.set(name, { start, text });
    });
    return bodies;
  };

  // Headings in a component's body, in document order. A local component is
  // chased at the position of its tag — a card component's title lands where
  // the page renders the card, not where the component is declared — so the
  // outline reflects the render order rather than the declaration order. The
  // chase is bounded and cycle-guarded by `path`; it is not deduped, because a
  // component rendered three times really does render three headings.
  const outlineOfComponent = (file, componentName, path, depth) => {
    if (depth >= MAX_HEADING_CHASE_DEPTH) return [];
    const key = `${file}#${componentName}`;
    if (path.has(key)) return [];
    const src = maskedSourceOf(file);
    const bodies = localComponentBodies(src);
    const body = bodies.get(componentName);
    if (!body) return [];
    const nextPath = new Set(path);
    nextPath.add(key);
    const out = [];
    for (const node of tagIndexOf(body.text)) {
      if (node.closing || node.tag === null) continue;
      const heading = /^h([1-6])$/.exec(node.name ?? '');
      if (heading) {
        out.push({ level: Number(heading[1]), file, line: lineOf(src, body.start + node.index) });
        continue;
      }
      if (node.name && COMPONENT_TAG_NAME.test(node.name) && bodies.has(node.name)) {
        out.push(...outlineOfComponent(file, node.name, nextPath, depth + 1));
      }
    }
    return out;
  };

  // The outline of a routed page element. The page's own h1 — a direct `<h1>`
  // in the page component's JSX — is in the outline already; otherwise the page
  // renders PageHeader (or renders under a shell that owns the h1), which the
  // walk does not chase, so a synthetic level-1 anchor is prepended. Either
  // way the page's own headings are checked against level 1.
  const outlineOfPage = (element) => {
    const src = maskedSourceOf(element.file);
    const componentName = element.exportedName === 'default' ? defaultExportName(src) : element.exportedName;
    if (!componentName) return null;
    const own = outlineOfComponent(element.file, componentName, new Set(), 0);
    if (element.shelled || !own.some((h) => h.level === 1)) {
      return [{ level: 1, file: element.file, line: 1 }, ...own];
    }
    return own;
  };

  // Documented exceptions: pages whose heading outline still jumps by more
  // than one level, pending the heading-order fix. An entry must name a page
  // that really jumps — the staleness check below fails on a stale entry, so
  // the list only shrinks.
  const HEADING_ORDER_ALLOWLIST = new Set([
    'src/pages/Browser.jsx',       // h1 → h3 section headings (#17323-class)
    'src/pages/CapabilityMap.jsx', // h1 → h3 section headings (#17323-class)
    'src/pages/FeatureAgents.jsx', // h1 → h3 empty-state heading (#17323-class)
    'src/pages/Templates.jsx',     // h2 → h4 "About Templates" (#17323-class)
    'src/pages/JiraReports.jsx',   // h1 → h3 card titles (#17323-class)
  ]);

  const headingOrderOffenders = (elements) => {
    const offenders = [];
    for (const element of elements) {
      if (HEADINGLESS_ROUTE_ELEMENTS.has(element.file) || ROUTE_HEADING_GAP_ALLOWLIST.has(element.file)) continue;
      const outline = outlineOfPage(element);
      if (outline === null) continue;
      for (let i = 1; i < outline.length; i++) {
        if (outline[i].level - outline[i - 1].level > 1) {
          offenders.push({ file: element.file, jump: `h${outline[i - 1].level} → h${outline[i].level}`, line: outline[i].line });
        }
      }
    }
    return offenders;
  };

  it('keeps heading levels ordered on routed pages (#17334)', () => {
    const elements = routedPageElements('src/App.jsx');
    // Probe first — a walker change that finds no Route elements must not pass
    // over an empty set.
    expect(elements.length, 'found no routed page elements in src/App.jsx — has the route table or its lazy-import idiom changed?').toBeGreaterThanOrEqual(90);

    const offenders = headingOrderOffenders(elements);
    const unlisted = offenders.filter((o) => !HEADING_ORDER_ALLOWLIST.has(o.file));
    expect(unlisted, `Routed page headings increase by more than one level in document order — heading navigation expects the outline to climb one level at a time (WCAG 1.3.1/3.2.4):\n${unlisted.map((o) => `${o.file} — heading jump ${o.jump} at line ${o.line}`).join('\n')}`).toEqual([]);
  });

  it('flags an h1 → h3 jump on a routed page and passes a clean page (#17334)', () => {
    // The rule is only real if it fails on a deliberately broken fixture — the
    // probe below is the proof, run through the real walk rather than a
    // hand-called decoder.
    withVirtualSources({
      'src/ProbeApp.jsx': `
        import { Routes, Route } from 'react-router';
        import Good from './pages/ProbeGood';
        import Bad from './pages/ProbeBad';
        export default function ProbeApp() {
          return (
            <Routes>
              <Route path="/" element={<Good />} />
              <Route path="/bad" element={<Bad />} />
            </Routes>
          );
        }
      `,
      'src/pages/ProbeGood.jsx': 'export default function ProbeGood() {\n  return <div><h1>Good</h1><h2>Section</h2><h3>Sub</h3></div>;\n}',
      'src/pages/ProbeBad.jsx': 'export default function ProbeBad() {\n  return <div><h1>Bad</h1><h3>Skipped</h3></div>;\n}',
    }, () => {
      const offenders = headingOrderOffenders(routedPageElements('src/ProbeApp.jsx'));
      expect(offenders).toEqual([{ file: 'src/pages/ProbeBad.jsx', jump: 'h1 → h3', line: 2 }]);
    });
  });

  it('keeps no stale entries in the heading-order exemption list (#17334)', () => {
    // The allowlist only shrinks. An entry whose page no longer jumps is dead
    // weight that quietly re-exempts the next heading omission routed to that
    // file — the same rule the heading-presence lists follow.
    const elements = routedPageElements('src/App.jsx');
    const jumping = new Set(headingOrderOffenders(elements).map((o) => o.file));
    const stale = [...HEADING_ORDER_ALLOWLIST].filter((file) => !jumping.has(file));
    expect(stale, `heading-order exemption entries that no longer match a jumping routed element — delete them:\n${stale.join('\n')}`).toEqual([]);
  });
});
