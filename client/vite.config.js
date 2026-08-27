import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const ANALYZE_BUNDLE = process.env.ANALYZE === 'true';
const CONFIG_DIR = import.meta.dirname;

const rootPkg = JSON.parse(readFileSync(resolve(CONFIG_DIR, '../package.json'), 'utf-8'));

// Which commit this BUNDLE was built from (#4694). package.json's version cannot
// answer that — by project rule it reflects the last RELEASE and is identical
// across every development commit — so a dist/ built three days ago looks exactly
// like one built this minute. Full rationale: server/lib/buildIdentity.js.
//
// Fail-soft: a source-tarball build has no .git and must still build, so every
// probe degrades to `null` — the SAME absent sentinel the server sends, so the
// client comparison has one vocabulary to understand rather than two. Never `''`
// and never a placeholder string: a blank commit compares unequal to every real
// commit, and a branch literally named "unknown" would be swallowed as absent.
function gitStamp(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: CONFIG_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    return out.trim() || null;
  } catch {
    // No git, no repo, or a timeout.
    return null;
  }
}

// Separate from `gitStamp` on purpose: `status --porcelain` prints NOTHING for
// a clean tree, so that helper's `|| null` would make clean and failed
// identical — and reading a failure as clean is exactly what lets the panel
// claim an agreement it never verified. Here the empty string IS the answer,
// and only a throw means "could not check".
//
// Returns true (dirty) / false (clean) / null (unknown).
function gitDirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: CONFIG_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    return out.trim() !== '';
  } catch {
    return null;
  }
}

function buildStamp() {
  const head = gitStamp(['rev-parse', '--abbrev-ref', 'HEAD']);
  // Were the CLIENT sources uncommitted when this bundle was built? Scoped to
  // this directory (`-- .`) on purpose: a dirty server file says nothing about
  // what went into the bundle, and repo-wide would mark every dist dirty during
  // ordinary server work. Without this the commit id alone is not enough — a
  // dist built from an edited tree carries its parent's clean commit, and the
  // panel would assert full agreement for code that was never committed.
  return {
    commit: gitStamp(['rev-parse', '--short=7', 'HEAD']),
    // `rev-parse --abbrev-ref` prints the literal string `HEAD` on a detached
    // checkout, which is not a branch name. (git refuses to CREATE a branch
    // named HEAD, so this is never a real branch.)
    branch: head === 'HEAD' ? null : head,
    // null = we could not check, distinct from false = checked and clean.
    dirty: gitDirty(),
    // Commit / branch / dirty / timestamp only. No paths (they embed the OS
    // username), no hostname — this ships to every browser that loads the app.
    builtAt: new Date().toISOString()
  };
}

// Dev proxy target: probe for the self-signed/LE cert under data/certs/. If the
// server is running HTTPS, the dev proxy must target HTTPS too (or requests
// through Vite return "socket hang up"). `secure: false` accepts the cert
// whether it's the trusted LE one or the self-signed fallback.
const CERT_PATH = resolve(CONFIG_DIR, '..', 'data', 'certs', 'cert.pem');
const API_SCHEME = existsSync(CERT_PATH) ? 'https' : 'http';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const API_HOST = env.VITE_API_HOST || 'localhost';
  const API_TARGET = `${API_SCHEME}://${API_HOST}:5555`;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(rootPkg.version),
      __BUILD_STAMP__: JSON.stringify(buildStamp())
    },
    plugins: [
      react(),
      ANALYZE_BUNDLE && visualizer({
        filename: 'dist/bundle-report.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap',
      }),
    ].filter(Boolean),
    server: {
      host: '0.0.0.0',
      port: 5554,
      // Fail loudly if 5554 is taken instead of auto-incrementing. Without this,
      // Vite walks up to the next free port and can land on a reserved PortOS
      // port (5555 API, 5556 browser CDP) — squatting on the CDP port makes the
      // browser keep-alive read Vite's HTML index and spam JSON-parse errors.
      strictPort: true,
      open: false,
      allowedHosts: ['.ts.net', 'localhost'],
      proxy: {
        // Anchor the API namespace so client routes such as `/api-reference`
        // stay on Vite. A plain `/api` context uses `startsWith` and would
        // steal every client page whose first segment begins with those
        // characters.
        '^/api(?:/|$)': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        // Every `/data/**` asset mount at once, instead of a hand-maintained
        // list that silently fell behind the server's (see docs/PORTS.md:
        // an unproxied `/data` path is answered by Vite's SPA fallback with
        // index.html and a 200, so a binary loader parses HTML). Anchored as a
        // regex on purpose: Vite matches a plain context with a bare
        // `url.startsWith`, so a `'/data'` key would also swallow the `/data`
        // (Data Manager) and `/datadog` client routes and hand them the API's
        // stale built index.html. `scripts/dev-proxy-drift.test.js` holds both
        // halves of that — mounts covered, client routes untouched.
        '^/data/': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/socket.io': {
          target: API_TARGET,
          changeOrigin: true,
          ws: true,
          secure: false
        }
      }
    },
    build: {
      rolldownOptions: {
        output: {
          // Vite 8 ships the rolldown bundler, whose canonical chunking API is
          // `output.codeSplitting.groups` — each group captures the modules whose
          // id matches `test` into a named chunk. This replaces the legacy
          // `rollupOptions.output.manualChunks` function (still accepted via
          // rolldown's compat layer, but slated to drop in a future Vite). The
          // groups below reproduce the same four vendor chunks as before.
          // Note: use `[\\/]` (not `/`) for the path separator so the regexes
          // also match on Windows.
          codeSplitting: {
            groups: [
              // Core React dependencies
              { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|react-router)[\\/]/ },
              // Socket dependencies
              { name: 'vendor-realtime', test: /[\\/]node_modules[\\/]socket\.io-client[\\/]/ },
              // Drag and drop library (only used in CoS)
              { name: 'vendor-dnd', test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/ },
              // Icon library (largest dependency)
              { name: 'vendor-icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/ },
              // 3D stack — only pulled into lazy 3D pages (CyberCity, avatars,
              // BrainGraph). Naming it gives the ~1 MB chunk a stable identity
              // instead of an opaque `OrbitControls-*.js` and guarantees a single
              // shared chunk across all 3D consumers.
              { name: 'vendor-three', test: /[\\/]node_modules[\\/](three|@react-three|three-fenestra)[\\/]/ },
              // Charting (recharts) — lazy chart pages only
              { name: 'vendor-charts', test: /[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-[^\\/]+)[\\/]/ },
              // Terminal emulator (xterm) — Shell page only
              { name: 'vendor-term', test: /[\\/]node_modules[\\/]@xterm[\\/]/ },
            ]
          }
        }
      },
      // Enable source maps for debugging in production
      sourcemap: false,
      // Increase chunk size warning limit (icons are large)
      chunkSizeWarningLimit: 600
    }
  };
});
