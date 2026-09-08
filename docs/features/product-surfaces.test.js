/**
 * Route-inventory guard for docs/features/product-surfaces.md, scoped to the
 * Comms section of the nav manifest (#40/#30: the Comms feature group and the
 * Beeper bridge).
 *
 * docs/README.md calls this file "a complete, user-facing inventory" with one
 * row per route, and nothing enforced that claim: /messages/beeper and
 * /messages/beeper?settings=1 shipped with no row at all. This guard catches
 * the next Comms route that lands the same way.
 *
 * Scope is deliberately narrower than "every NAV_COMMANDS path" — this change
 * only touches the Comms section, and a repo-wide version of this guard would
 * fail today on pre-existing gaps this change did not introduce:
 *   - /messages/signal — the doc row still names the pre-#30 previousPath
 *     `/settings/signal`, not the live path.
 *   - /messages/config — no row at all.
 *   - /messages/imessage?settings=1 — no row at all (the bare /messages/imessage
 *     row does not cover the settings-drawer deep link).
 * Those are listed as a follow-up in this change's PR description rather than
 * fixed here; KNOWN_UNRELATED_GAPS keeps this guard from failing on them so it
 * can still catch a *new* undocumented Comms route.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { NAV_COMMANDS } from '../../server/lib/navManifest.js';

const DOC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'product-surfaces.md'), 'utf8');

const SECTION_HEADING = '## 6. Communications, Voice, Social, & Spatial UI';

// Pre-existing gaps this change did not introduce — see the file comment above.
const KNOWN_UNRELATED_GAPS = new Set([
  '/messages/signal',
  '/messages/config',
  '/messages/imessage?settings=1',
]);

/**
 * Every backticked path in the Route(s) column of the Comms/messaging section's
 * table rows. Scoped to that one section (between its heading and the next
 * `## `) rather than the whole document, so a path documented somewhere else
 * entirely (a Settings or Digital Twin row reusing similar wording) can't be
 * mistaken for coverage here.
 */
function commsSectionDocumentedPaths() {
  const start = DOC.indexOf(SECTION_HEADING);
  const afterHeading = DOC.slice(start + SECTION_HEADING.length);
  const end = afterHeading.indexOf('\n## ');
  const section = end === -1 ? afterHeading : afterHeading.slice(0, end);
  const paths = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const routeCell = line.split('|')[2] ?? '';
    for (const match of routeCell.matchAll(/`([^`]+)`/g)) {
      paths.add(match[1]);
    }
  }
  return paths;
}

describe('docs/features/product-surfaces.md — Comms route inventory', () => {
  it('documents every Comms nav-manifest path not already tracked as a pre-existing gap', () => {
    const documented = commsSectionDocumentedPaths();
    const commsPaths = NAV_COMMANDS
      .filter((command) => command.section === 'Comms')
      .map((command) => command.path)
      .filter((path) => !KNOWN_UNRELATED_GAPS.has(path));

    const missing = commsPaths.filter((path) => !documented.has(path));
    expect(missing).toEqual([]);
  });

  it('scans a non-empty set of manifest paths and documented routes (detector self-check)', () => {
    expect(NAV_COMMANDS.filter((command) => command.section === 'Comms').length).toBeGreaterThan(0);
    expect(commsSectionDocumentedPaths().size).toBeGreaterThan(0);
  });
});
