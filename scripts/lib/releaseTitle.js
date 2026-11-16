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

/** GitHub caps a release body at 125,000 chars; notes beyond this are refused, never truncated. */
export const RELEASE_NOTES_MAX_BYTES = 100 * 1024;

/**
 * Why `.changelog/RELEASE.md` must not be published for `version`, or null when
 * it can be. The file is overwritten per release, so a heading for another
 * version means release preparation skipped it; the body must also fit GitHub
 * whole because no archived file remains to link the remainder to.
 */
export function releaseNotesProblem(changelog, version) {
  const text = String(changelog);
  const heading = text.split(/\r?\n/).find(line => /^#\s/.test(line));
  const match = heading?.match(/^# Release v(\S+?)(?: - .+)?$/);
  if (!match || match[1] !== version) {
    return `release notes heading ${JSON.stringify(heading ?? null)} does not name v${version}`;
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > RELEASE_NOTES_MAX_BYTES) {
    return `release notes are ${bytes} bytes, over the ${RELEASE_NOTES_MAX_BYTES}-byte limit; shorten them (GitHub Releases is the archive and the body must be complete)`;
  }
  return null;
}
