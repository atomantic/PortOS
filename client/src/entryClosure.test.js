// @vitest-environment node
// test-memo: never (tree-wide scanner)

// Every module statically reachable from `main.jsx` ships in the cold-load
// preload set. Large page API modules stay out of this set (#16562). The
// sidebar reads their name lists through `services/apiNavNames.js`.
//
// The voice stack is held out the same way (#16563): voice is off by default,
// so `components/voice/VoiceWidgetGate.jsx` is the only voice code the shell
// imports, and it loads the widget (and with it the voice client and the audio
// helpers) on demand.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './test/stripComments.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(SRC, 'main.jsx');
const PAGE_ONLY_MODULES = ['services/apiMusicVideo.js', 'services/apiPipeline.js'];
const VOICE_STACK_MODULES = [
  'components/voice/VoiceWidget.jsx',
  'services/voiceClient.js',
  'services/voiceFastPath.js',
  'services/domIndex.js',
  'lib/audioRecorder.js',
  'lib/audioContext.js',
];
// Shell overlays and domain-specific helpers stay out of the cold-load bundle
// until invoked (#17007): CmdKSearch and KeyboardHelp sit behind thin hotkey
// gates, OutputBlocks/MarkdownOutput load when a toast expands, and
// the Catalog type store populates lazily when a consumer mounts.
const LAZY_SHELL_MODULES = [
  'components/CmdKSearch.jsx',
  'components/KeyboardHelp.jsx',
  'components/ThemeSwitcher.jsx',
  'components/cos/OutputBlocks.jsx',
  'components/cos/MarkdownOutput.jsx',
  'lib/creativeLibraries.js',
  'lib/catalogTypes.js',
  'themes/portosThemes.js',
  '../../server/lib/navSearchMetadata.js',
  '../../server/lib/greyboxVocabulary.js',
  '../../server/lib/bibleLimits.js',
];
// The landing Dashboard page and its widgets contribute to first paint too
// (#16813), so each is a separate root for the page-only API checks.
const DASHBOARD_ROOTS = [
  'pages/Dashboard.jsx',
  ...readdirSync(resolve(SRC, 'components/dashboard'), { recursive: true })
    .filter((file) => /\.jsx$/.test(file) && !/\.test\.jsx$/.test(file))
    .map((file) => `components/dashboard/${file}`),
];
const CODE_EXT = /\.(?:jsx?|mjs|tsx?)$/;
const RESOLVE_SUFFIXES = ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx'];

// Static `import … from`, side-effect `import '…'` and `export … from`.
// `import('…')` is deliberately not matched: a lazy chunk is not cold load.
const STATIC_SPECIFIER = /\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?['"]([^'"\n]+)['"]/g;

const staticSpecifiers = (source) =>
  [...stripComments(source).matchAll(STATIC_SPECIFIER)].map((match) => match[1]);

const resolveRelative = (fromFile, specifier, exists) => {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.split('?')[0]);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (CODE_EXT.test(candidate) && exists(candidate)) return candidate;
  }
  return null;
};

// Breadth-first walk; returns the importer chain from `entry` to `target`, or null.
function findStaticPath(entry, target, { read = (file) => readFileSync(file, 'utf8'), exists = existsSync } = {}) {
  const parent = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (file === target) {
      const chain = [];
      for (let step = file; step; step = parent.get(step)) chain.unshift(step);
      return chain;
    }
    for (const specifier of staticSpecifiers(read(file))) {
      const next = resolveRelative(file, specifier, exists);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

const chainFromEntry = (module) => {
  const chain = findStaticPath(ENTRY, resolve(SRC, module));
  return chain ? chain.map((file) => file.slice(SRC.length + 1)).join(' -> ') : null;
};

describe('cold-load entry closure (#16562)', () => {
  it.each(PAGE_ONLY_MODULES)('main.jsx never statically reaches %s', (module) => {
    expect(chainFromEntry(module), 'import a narrower services/apiX.js module, or load this one lazily').toBeNull();
  });

  it.each(VOICE_STACK_MODULES)('main.jsx never statically reaches the voice stack through %s', (module) => {
    expect(
      chainFromEntry(module),
      'shell code reads voice state from components/voice/VoiceWidgetGate.jsx; anything that needs this module loads it lazily',
    ).toBeNull();
  });

  it.each(DASHBOARD_ROOTS)('%s never statically reaches page-only api modules (#16813)', (root) => {
    for (const mod of PAGE_ONLY_MODULES) {
      const chain = findStaticPath(resolve(SRC, root), resolve(SRC, mod));
      expect(
        chain && chain.map((file) => file.slice(SRC.length + 1)).join(' -> '),
        `import a narrower services/apiX.js module instead of ${mod}`,
      ).toBeFalsy();
    }
  });

  it.each(LAZY_SHELL_MODULES)('main.jsx never statically reaches lazy shell or domain module %s (#17007)', (module) => {
    const chain = findStaticPath(ENTRY, resolve(SRC, module));
    expect(
      chain && chain.map((file) => (file.startsWith(SRC) ? file.slice(SRC.length + 1) : file)).join(' -> '),
      'load this overlay or domain helper lazily instead of importing it into the cold-load shell',
    ).toBeNull();
  });

  it('still reaches the gates that load the voice stack and shell overlays on demand', () => {
    expect(chainFromEntry('components/voice/VoiceWidgetGate.jsx')).not.toBeNull();
    expect(chainFromEntry('components/CmdKSearchGate.jsx')).not.toBeNull();
    expect(chainFromEntry('components/KeyboardHelpGate.jsx')).not.toBeNull();
    expect(chainFromEntry('components/ThemeSwitcherGate.jsx')).not.toBeNull();
  });

  it('follows static imports and re-exports, but not dynamic import()', () => {
    const files = {
      '/app/main.jsx': "import App from './App';\nimport './index.css';",
      '/app/App.jsx': "// import * as api from './services/api';\nconst Page = lazy(() => import('./Page.jsx'));\nexport { useThing } from './hooks/useThing.js';",
      '/app/Page.jsx': "import * as api from './services/api';",
      '/app/hooks/useThing.js': "import {\n  getThing,\n} from '../services/apiThing.js';",
      '/app/services/apiThing.js': 'export const getThing = () => null;',
      '/app/services/api.js': "export * from './apiThing.js';",
    };
    const fs = { read: (file) => files[file], exists: (file) => file in files };
    expect(findStaticPath('/app/main.jsx', '/app/services/api.js', fs)).toBeNull();

    files['/app/hooks/useThing.js'] = "import { getThing } from '../services/api';";
    expect(findStaticPath('/app/main.jsx', '/app/services/api.js', fs)).toEqual([
      '/app/main.jsx', '/app/App.jsx', '/app/hooks/useThing.js', '/app/services/api.js',
    ]);
  });
});
