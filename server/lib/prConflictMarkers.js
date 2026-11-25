/** Inspect added lines only. Never execute or preserve contributor code. */
export function findAddedConflictMarkers(diff) {
  const findings = [];
  let path = null;
  let nextLine = null;
  let block = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      path = null;
      nextLine = null;
      block = null;
    } else if (nextLine === null && line.startsWith('+++ ')) {
      // An allowlist keeps names inert in the generated Markdown body. Limit
      // to source files; documentation may show conflict markers deliberately.
      path = /^\+\+\+ b\/([\w./-]{1,240}\.(?:[cm]?js|jsx|tsx?))$/.exec(line)?.[1] ?? null;
    } else if (line.startsWith('@@ ')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      nextLine = hunk ? Number(hunk[1]) : null;
      block = null;
    } else if (path && nextLine !== null && /^[ +]/.test(line)) {
      const location = nextLine++;
      if (!line.startsWith('+')) continue;
      if (/^\+<{7} \S/.test(line)) block = { line: location, separated: false };
      else if (block && line === '+=======') block.separated = true;
      else if (block && /^\+>{7} \S/.test(line)) {
        if (block.separated) findings.push({ path, line: block.line, endLine: location });
        if (findings.length === 5) return findings;
        block = null;
      }
    }
  }
  return findings;
}

/** Prove the matching block belongs to a file at the exact review commit. */
export function matchesConflictMarkerBlock(source, { line, endLine }) {
  const lines = source.split(/\r?\n/);
  if (!/^<{7} \S/.test(lines[line - 1] ?? '') || !/^>{7} \S/.test(lines[endLine - 1] ?? '')) return false;
  return lines.slice(line, endLine - 1).includes('=======');
}
