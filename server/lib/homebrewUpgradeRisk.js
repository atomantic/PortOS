/**
 * Classify each outdated Homebrew package by how its upgrade can affect what PortOS runs on (database, extensions, Node, ffmpeg, Python).
 *
 * Pure: the caller supplies `brew outdated --json=v2`, `brew info --json=v2` for the
 * outdated formulae, and what PortOS actually uses. The rules are about roles, not
 * package lists, so a new Postgres extension or a new versioned runtime is covered
 * without an edit here:
 *
 * - A formula whose new version no longer depends on a versioned runtime (`name@N`)
 *   it was built against today drops support for it. When PortOS runs on that
 *   runtime the upgrade removes files PortOS loads (a Postgres extension's library
 *   vanishes from that major's libdir, and every query using it fails with
 *   `could not access file "$libdir/…"`), so it is `breaking`.
 * - PortOS's own database formula restarts the database; a major change of an
 *   unversioned `postgresql` formula changes the on-disk format, so it is `breaking`.
 * - A formula that depends on PortOS's database formula is a database extension.
 * - Node, ffmpeg and Python are flagged when PortOS runs that copy.
 * - A library linked by a program PortOS runs that was built outside Homebrew (a
 *   pyenv Python links `gettext`'s libintl) breaks that program when the upgrade
 *   changes the library's file name, so it is `caution` and checked after.
 *
 * Risk only warns: the owner can upgrade anything that is not pinned.
 */

const VERSIONED = /^(.+)@(\d+(?:\.\d+)?)$/;
const RISK_ORDER = { breaking: 0, caution: 1, safe: 2, pinned: 3 };

const majorOf = (version) => String(version || '').match(/^(\d+)/)?.[1] ?? null;
const baseName = (name) => String(name || '').split('/').pop();

/** The Homebrew formula PortOS's native database runs from, or null for Docker / a non-Homebrew build. */
export function postgresFormulaFor(postgres) {
  if (!postgres || postgres.mode !== 'native' || !postgres.major || !/homebrew/i.test(postgres.build || '')) return null;
  return `postgresql@${postgres.major}`;
}

/**
 * The installed keg's dependencies, mapped to whether Homebrew recorded them as
 * declared directly. `runtime_dependencies` is transitive, and older receipts carry
 * no `declared_directly`, so `null` means "not known to be direct".
 */
function installedDependencies(info) {
  const deps = info?.installed?.[0]?.runtime_dependencies || [];
  return new Map(deps
    .map((dep) => [baseName(dep.full_name || dep.name), typeof dep.declared_directly === 'boolean' ? dep.declared_directly : null])
    .filter(([name]) => name));
}

/**
 * @param {object} pkg one `brew outdated --json=v2` entry plus `kind` ('formula'|'cask')
 * @param {object|null} info that formula's `brew info --json=v2` entry
 * @param {{postgresFormula?: string|null, nodeFormula?: string|null, ffmpegFormula?: string|null,
 *   pythonFormulas?: string[], linkedBy?: Record<string, string[]>}} uses `linkedBy` maps a formula
 *   to the programs built outside Homebrew that link one of its libraries
 */
export function classifyHomebrewUpgrade(pkg, info, uses = {}) {
  const name = baseName(pkg.name);
  const installed = pkg.installed_versions?.at(-1) || null;
  const current = pkg.current_version || null;
  const reasons = [];
  const checks = new Set();
  let risk = 'safe';
  const raise = (level, reason) => {
    if (RISK_ORDER[level] < RISK_ORDER[risk]) risk = level;
    if (reason) reasons.push(reason);
  };
  const majorChange = Boolean(majorOf(installed) && majorOf(current) && majorOf(installed) !== majorOf(current));

  if (pkg.kind === 'formula' && info) {
    const before = installedDependencies(info);
    const after = new Set((info.dependencies || []).map(baseName));
    for (const [dep, direct] of before) {
      if (!VERSIONED.test(dep) || after.has(dep) || direct === false) continue;
      // A runtime the new version stopped building against is a drop even when a
      // newer runtime replaced it: this install still runs the old one.
      if (dep === uses.postgresFormula) {
        raise('breaking', `${current} no longer supports ${dep}, which PortOS's database runs on. Upgrading removes it from that database.`);
        checks.add('postgres-extensions');
      } else if (direct === true) {
        raise('caution', `${current} drops ${dep}.`);
      }
    }
    if (uses.postgresFormula && after.has(uses.postgresFormula) && name !== uses.postgresFormula) {
      raise('caution', `Extension for PortOS's database (${uses.postgresFormula}); the database restarts and the extension is checked after.`);
      checks.add('postgres-extensions');
    }
  }

  if (uses.postgresFormula && name === uses.postgresFormula) {
    raise('caution', 'PortOS\'s database. It restarts after the upgrade and its extensions are checked.');
    checks.add('postgres-extensions');
  } else if (name === 'postgresql' && majorChange) {
    raise('breaking', `Moves the unversioned postgresql formula to a new major (${majorOf(installed)} → ${majorOf(current)}); existing data needs a dump and restore.`);
  }

  if (uses.nodeFormula && name === uses.nodeFormula) {
    raise(majorChange ? 'breaking' : 'caution', majorChange
      ? `PortOS runs on this Node. A new major (${majorOf(installed)} → ${majorOf(current)}) needs native modules rebuilt; pin PortOS to an nvm Node first.`
      : 'PortOS runs on this Node; it takes effect at the next PortOS restart.');
    checks.add('node');
  }

  if (uses.ffmpegFormula && name === uses.ffmpegFormula) {
    raise('caution', majorChange ? `Media features use this ffmpeg; a new major (${majorOf(installed)} → ${majorOf(current)}) can change codecs and filters.` : 'Media features use this ffmpeg.');
    checks.add('ffmpeg');
  }

  if ((uses.pythonFormulas || []).includes(name)) {
    raise('caution', 'PortOS Python environments were created from this Python and are checked after.');
    checks.add('python');
  }

  const linkers = uses.linkedBy?.[name] || [];
  if (linkers.length) {
    raise('caution', `Linked by ${linkers.join(', ')}, built outside Homebrew; a changed library breaks ${linkers.length === 1 ? 'it' : 'them'}. Checked after, and pyenv Pythons are rebuilt.`);
    checks.add('python');
  }

  if (pkg.pinned) {
    risk = 'pinned';
    reasons.unshift(`Pinned${pkg.pinned_version ? ` at ${pkg.pinned_version}` : ''}; run \`brew unpin ${name}\` to allow upgrades.`);
  }

  return {
    name, kind: pkg.kind, installed, current, risk, majorChange, reasons,
    checks: [...checks],
  };
}

/** Every outdated formula and cask, classified and ordered most risky first. */
export function classifyHomebrewOutdated(outdated, infos = [], uses = {}) {
  const byName = new Map((infos || []).map((info) => [baseName(info.name), info]));
  const packages = [
    ...(outdated?.formulae || []).map((pkg) => classifyHomebrewUpgrade({ ...pkg, kind: 'formula' }, byName.get(baseName(pkg.name)) || null, uses)),
    ...(outdated?.casks || []).map((pkg) => classifyHomebrewUpgrade({ ...pkg, kind: 'cask' }, null, uses)),
  ];
  return packages.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.name.localeCompare(b.name));
}
