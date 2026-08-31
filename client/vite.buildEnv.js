/**
 * Which `NODE_ENV` a Vite invocation must run under.
 *
 * Vite only defaults `NODE_ENV` to `production` for a build when it is UNSET —
 * `resolveConfig()` does `if (!isNodeEnvSet) process.env.NODE_ENV = defaultNodeEnv`
 * — so an inherited value wins. PortOS runs under PM2 with
 * `NODE_ENV=development` (ecosystem.config.cjs), and the client build is
 * reached from inside that process tree on the paths that matter most:
 * `npm start`, the self-updater (docs/SELF_UPDATE.md), and CoS agents. Every one
 * of those produced a `dist/` compiled as development, which makes the CJS entry
 * of react/react-dom resolve to their DEVELOPMENT builds.
 *
 * That is not a cosmetic difference:
 *   - `vendor-react` goes from ~284 kB to ~488 kB on the critical path;
 *   - every render pays the dev build's validation and warning machinery, and
 *     users get dev-only warnings in their console;
 *   - `<React.StrictMode>` (src/main.jsx) starts DOUBLE-INVOKING effects in the
 *     shipped app, so any mount effect with a side effect fires twice — one
 *     visit to /music persisted TWO empty "Untitled music draft" tracks, which
 *     then sync out to federated peers.
 *
 * `serve` keeps whatever it inherited: the dev server genuinely wants the dev
 * builds, and their warnings are the point.
 *
 * Kept dependency-free and OUTSIDE `src/` on purpose — vite.config.js imports it
 * to set `process.env.NODE_ENV` before Vite derives `isProduction`, its
 * `process.env.NODE_ENV` define, and the plugin JSX runtime from it, while
 * scripts/clientBuildEnv.test.js imports it under the server's node runner,
 * which has none of the client's dependencies installed.
 *
 * @param {'build'|'serve'} command - Vite's resolved command.
 * @param {string|undefined} ambientNodeEnv - `process.env.NODE_ENV` as inherited.
 * @returns {string} the NODE_ENV the invocation must run under.
 */
export const resolveBundleNodeEnv = (command, ambientNodeEnv) =>
  (command === 'build' ? 'production' : (ambientNodeEnv || 'development'));
