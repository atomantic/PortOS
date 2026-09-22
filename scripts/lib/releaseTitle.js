/**
 * Resolve the human-facing GitHub release title from a versioned changelog.
 *
 * The release agent owns the name, but the workflow owns publication. Keeping
 * this boundary in one dependency-free helper makes the heading contract
 * testable and gives older unnamed changelogs a safe fallback.
 */
export function releaseTitleFromChangelog(changelog, version) {
  const expectedPrefix = `# Release v${version} - `;
  const firstHeading = String(changelog)
    .split(/\r?\n/)
    .find(line => /^#\s/.test(line));

  if (firstHeading?.startsWith(expectedPrefix)) {
    const name = firstHeading.slice(expectedPrefix.length).trim();
    if (name) return firstHeading.slice(2).trim();
  }

  return `Release v${version}`;
}
