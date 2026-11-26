/**
 * Dependency-manifest verdicts for the CI planner: whether a package.json or lockfile change can alter what the Windows job installs.
 *
 * Split out of `scripts/ci-test-plan.js` (#16998), which re-exports the
 * public names. Builtins only: the planner runs before `npm ci`.
 */

const uniqueSorted = (values) => [...new Set(values)].sort();

export const DEPENDENCY_MANIFEST_RE = /^(?:package|server\/package|client\/package)(?:-lock)?\.json$/;

// Workspaces the windows-server job installs (`npm ci --prefix <dir>`). Only
// their manifests and .npmrc can change what that job runs, so a dependency or
// npm-config change elsewhere keeps the Windows baseline. ci-test-plan.test.js
// pins this list to the job's install steps in ci.yml.
export const WINDOWS_INSTALLED_WORKSPACES = ['server'];
export const windowsInstalls = (path) => WINDOWS_INSTALLED_WORKSPACES.some((dir) => path.startsWith(`${dir}/`));

// Packages whose installed files differ per platform although their lockfile
// entry may carry no os/cpu/install-script metadata: runtime dispatchers that
// pick a prebuilt binary (their per-platform children ARE os/cpu-tagged, and
// usually move with them), browser-binary downloaders, and native addons.
//
// The first row is every TRUSTED_REBUILDS package (scripts/trusted-rebuilds.js).
// It is matched here rather than imported: that module's spawn helpers would
// pull ~20 server modules into a planner that runs before any install.
// ci-test-plan.test.js fails when the allowlist names a package this list misses.
export const PLATFORM_PACKAGE_RES = [
  /^node-pty$/, /^sharp$/,
  /^@img\//, /^esbuild$/, /^@esbuild\//,
  /^rollup$/, /^@rollup\/rollup-/, /^rolldown$/, /^@rolldown\//, /^@biomejs\//,
  /^lightningcss(?:-|$)/, /^@tailwindcss\/oxide/, /^playwright(?:-core)?$/, /^@playwright\//,
  /^@swc\//, /^fsevents$/, /^bufferutil$/, /^utf-8-validate$/,
];
// Lockfile entry metadata npm uses to install a package conditionally per
// platform, or to run code at install time.
const PLATFORM_ENTRY_FIELDS = ['hasInstallScript', 'os', 'cpu', 'libc', 'optional', 'devOptional'];
// package.json fields whose change installs the same files on every platform.
// Dependency maps are checked per changed name; any other field (engines,
// overrides, optionalDependencies, scripts, os, cpu, …) escalates.
const PLATFORM_NEUTRAL_MANIFEST_FIELDS = new Set([
  'name', 'version', 'description', 'keywords', 'author', 'license', 'homepage', 'repository', 'bugs', 'private',
]);
const MANIFEST_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];
// Lockfile root entry ("") fields that mirror the dependency maps; the
// node_modules/* entries carry the real change.
const LOCKFILE_ROOT_NEUTRAL_FIELDS = new Set(['name', 'version', 'license', ...MANIFEST_DEPENDENCY_FIELDS]);

const isPlatformPackageName = (name) => PLATFORM_PACKAGE_RES.some((re) => re.test(name));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changedKeys = (base = {}, head = {}) => uniqueSorted([...Object.keys(base), ...Object.keys(head)])
  .filter((key) => !sameJson(base[key], head[key]));
const packageNameFromLockKey = (key, entry) => entry?.name
  ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const escalated = (reason, packages = []) => ({ escalate: true, reason, packages: uniqueSorted(packages) });

function classifyLockfile(base, head) {
  if (!isPlainObject(base.packages) || !isPlainObject(head.packages)) {
    return escalated('lockfile has no packages map to compare');
  }
  const topLevel = changedKeys(base, head).filter((key) => !['packages', 'name', 'version'].includes(key));
  if (topLevel.length > 0) return escalated(`lockfile ${topLevel.join(', ')} changed`);
  const rootFields = changedKeys(base.packages[''], head.packages[''])
    .filter((key) => !LOCKFILE_ROOT_NEUTRAL_FIELDS.has(key));
  if (rootFields.length > 0) return escalated(`root ${rootFields.join(', ')} changed`);

  const changed = changedKeys(base.packages, head.packages).filter((key) => key !== '').map((key) => {
    const entries = [base.packages[key], head.packages[key]].filter(isPlainObject);
    const name = packageNameFromLockKey(key, head.packages[key] ?? base.packages[key]);
    const sensitive = isPlatformPackageName(name) || entries.some((entry) => PLATFORM_ENTRY_FIELDS
      .some((field) => entry[field] !== undefined && entry[field] !== false));
    return { name, sensitive };
  });
  const sensitive = changed.filter((pkg) => pkg.sensitive).map((pkg) => pkg.name);
  if (sensitive.length > 0) return escalated('platform-sensitive package changed', sensitive);
  return { escalate: false, reason: 'no platform-sensitive package changed', packages: uniqueSorted(changed.map((pkg) => pkg.name)) };
}

function classifyManifest(base, head) {
  const fields = changedKeys(base, head).filter((key) => !PLATFORM_NEUTRAL_MANIFEST_FIELDS.has(key));
  const unsafe = fields.filter((key) => !MANIFEST_DEPENDENCY_FIELDS.includes(key));
  if (unsafe.length > 0) return escalated(`${unsafe.join(', ')} changed`);
  const names = uniqueSorted(fields.flatMap((field) => changedKeys(
    isPlainObject(base[field]) ? base[field] : {},
    isPlainObject(head[field]) ? head[field] : {},
  )));
  const sensitive = names.filter(isPlatformPackageName);
  if (sensitive.length > 0) return escalated('platform-sensitive package changed', sensitive);
  return { escalate: false, reason: 'no platform-sensitive package changed', packages: names };
}

/**
 * Does this manifest change require the Windows native contract job?
 *
 * `baseText`/`headText` are the file's contents at the diff base and in the
 * tree under test; null means unavailable (new, deleted, or unreadable). Any
 * input the planner cannot read and compare fails closed to escalation, so
 * only a proven platform-neutral change downgrades Windows.
 *
 * Returns { escalate, reason, packages } — `packages` names what drove the
 * decision: the platform-sensitive packages when escalating, every changed
 * package otherwise.
 */
export function classifyDependencyChange(path, baseText, headText) {
  if (baseText == null) return escalated('base version unavailable');
  if (headText == null) return escalated('removed or unreadable in the tree under test');
  let base;
  let head;
  try {
    base = JSON.parse(baseText);
    head = JSON.parse(headText);
  } catch {
    return escalated('could not be parsed');
  }
  if (!isPlainObject(base) || !isPlainObject(head)) return escalated('could not be parsed');
  return path.endsWith('-lock.json') ? classifyLockfile(base, head) : classifyManifest(base, head);
}

const MAX_NAMED_PACKAGES = 8;
export const describeDependencyVerdict = (path, { escalate, reason, packages }) => {
  const named = packages.length > MAX_NAMED_PACKAGES
    ? `${packages.slice(0, MAX_NAMED_PACKAGES).join(', ')} and ${packages.length - MAX_NAMED_PACKAGES} more`
    : packages.join(', ');
  return `${path} ${escalate ? 'selects Windows native contracts' : 'does not select Windows native contracts'}: ${reason}${named ? ` (${named})` : ''}`;
};
