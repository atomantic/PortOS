/**
 * Accessibility conventions: a heading on every routed page.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { maskedSourceOf, forEachOpeningTag, renderedTagNames } from '../../a11yScanCore.js';
import { resolveRelativeImport, relativeImportBindings, reExportBindings, withVirtualSources } from '../../a11yScanWrappers.js';

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
    'src/pages/Ambient.jsx',        // chromeless ambient display — wants an sr-only h1, not a bar
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
});
