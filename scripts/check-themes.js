import { strict as assert } from 'node:assert';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THEME_ID,
  LEGACY_THEME_ALIASES,
  THEME_IDS,
  THEMES,
  getTheme,
  normalizeThemeId,
} from '../client/src/themes/portosThemes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const REQUIRED_COLOR_VARS = [
  '--port-bg',
  '--port-card',
  '--port-border',
  '--port-accent',
  '--port-success',
  '--port-warning',
  '--port-error',
  '--port-on-accent',
  '--port-on-success',
  '--port-on-warning',
  '--port-on-error',
  '--port-text',
  '--port-text-muted',
  '--port-control-text',
  '--port-focus-ring',
];

const REQUIRED_TOKEN_VARS = [
  '--port-radius-sm',
  '--port-radius-md',
  '--port-radius-lg',
  '--port-radius-xl',
  '--port-radius-pill',
  '--port-font-ui',
  '--port-font-display',
  '--port-font-mono',
  '--port-shadow-card',
  '--port-shadow-elevated',
  '--port-shadow-interactive',
  '--port-backdrop-filter',
  '--port-body-gradient',
  '--port-body-texture',
  '--port-app-backdrop',
  '--port-sidebar-bg',
  '--port-input-bg',
  '--port-control-bg',
  '--port-control-bg-hover',
  '--port-control-border',
  '--port-active-bg',
  '--port-hover-bg',
  '--port-terminal-bg',
  '--port-terminal-text',
  '--port-chart-1',
  '--port-chart-2',
  '--port-chart-3',
  '--port-chart-4',
  '--port-chart-grid',
];

const REQUIRED_DOC_SECTIONS = [
  '## Intent',
  '## Integration Rules',
  '## Component Notes',
  '## Validation',
];

function assertRgbChannels(value, themeId, varName) {
  assert(typeof value === 'string', `${themeId} ${varName} must be a string`);
  assert(/^\d{1,3} \d{1,3} \d{1,3}$/.test(value), `${themeId} ${varName} must be RGB channels`);
  for (const channel of value.split(' ').map(Number)) {
    assert(channel >= 0 && channel <= 255, `${themeId} ${varName} has out-of-range channel ${channel}`);
  }
}

async function checkThemeDocs(theme) {
  assert(theme.doc?.startsWith('/docs/themes/'), `${theme.id} doc must live under docs/themes`);
  const docPath = join(repoRoot, theme.doc.slice(1));
  await access(docPath);
  const contents = await readFile(docPath, 'utf8');
  for (const section of REQUIRED_DOC_SECTIONS) {
    assert(contents.includes(section), `${theme.id} doc is missing ${section}`);
  }
}

async function main() {
  assert(THEME_IDS.includes(DEFAULT_THEME_ID), 'DEFAULT_THEME_ID is not registered');
  assert(THEME_IDS.length >= 4, 'Expected classic plus at least three concept themes');

  const labels = new Set();
  for (const id of THEME_IDS) {
    const theme = THEMES[id];
    assert(theme.id === id, `${id} manifest id mismatch`);
    assert(!labels.has(theme.label), `${id} label is duplicated`);
    labels.add(theme.label);
    assert(theme.concept?.length > 20, `${id} needs a concept statement`);
    assert(theme.family, `${id} needs a family`);
    assert(theme.density, `${id} needs a density`);
    assert(theme.accent?.startsWith('#'), `${id} needs a hex accent`);
    assert(Array.isArray(theme.swatches) && theme.swatches.length >= 4, `${id} needs at least four swatches`);

    for (const varName of REQUIRED_COLOR_VARS) {
      assertRgbChannels(theme.colors[varName], id, varName);
    }
    for (const varName of REQUIRED_TOKEN_VARS) {
      assert(theme.tokens[varName], `${id} is missing token ${varName}`);
    }
    await checkThemeDocs(theme);
  }

  for (const [legacyId, nextId] of Object.entries(LEGACY_THEME_ALIASES)) {
    assert(THEMES[nextId], `Legacy alias ${legacyId} points to unknown theme ${nextId}`);
    assert(normalizeThemeId(legacyId) === nextId, `Legacy alias ${legacyId} did not normalize`);
    assert(getTheme(legacyId).id === nextId, `getTheme(${legacyId}) did not return alias target`);
  }

  const css = await readFile(join(repoRoot, 'client/src/index.css'), 'utf8');
  for (const id of THEME_IDS) {
    assert(
      id === DEFAULT_THEME_ID || css.includes(`data-port-theme="${id}"`),
      `index.css is missing a theme-specific selector for ${id}`,
    );
  }
  assert(css.includes('data-port-theme'), 'index.css must include the theme runtime layer');

  console.log(`Theme contract OK: ${THEME_IDS.join(', ')}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
