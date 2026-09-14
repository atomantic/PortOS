/**
 * Pure argument shapes and output parsing for `gh` / `glab` issue filing.
 *
 * Two CLIs disagree about the same three things, and every filer that has
 * rediscovered that disagreement has re-encoded it: the body flag
 * (`--body` vs `--description`), how labels attach (repeated `--label` flags vs
 * one comma-joined value), and how a label is created (gh takes the name
 * positionally with a bare hex color; glab needs `--name` and a
 * `#`-prefixed color). Keeping those here means a new filer inherits the rules
 * instead of learning them from a failed 422.
 *
 * No child-process or network access — callers own the exec (`runCli` in the
 * Layered Intelligence loop, `execGh`/`execGlab` elsewhere).
 */

/** `label create` arguments for one `{ name, color, description }` spec. */
export const forgeLabelCreateArgs = (cli, spec, { repo = null } = {}) => (cli === 'glab'
  ? ['label', 'create', '--name', spec.name, '--color', `#${spec.color}`, '--description', spec.description]
  : ['label', 'create', spec.name, ...(repo ? ['--repo', repo] : []),
    '--color', spec.color, '--description', spec.description]);

/** `issue create` arguments for one issue. */
export const forgeIssueCreateArgs = (cli, { title, body, labels = [], repo = null } = {}) => (cli === 'glab'
  ? ['issue', 'create', '--title', title, '--description', body,
    ...(labels.length ? ['--label', labels.join(',')] : [])]
  : ['issue', 'create', ...(repo ? ['--repo', repo] : []), '--title', title, '--body', body,
    ...labels.flatMap((name) => ['--label', name])]);

/**
 * The created issue's `{ url, number }` from a successful `issue create` stdout.
 *
 * Both CLIs print the web URL. `number` is null when the trailing path segment
 * is not a number, and `url` falls back to the raw trimmed stdout — the issue
 * exists either way, so an unparseable line must not turn a real creation into
 * a reported failure.
 */
export const parseCreatedForgeIssue = (stdout) => {
  const text = String(stdout || '').trim();
  const url = text.match(/(https?:\/\/\S+)/)?.[1] || text;
  const number = Number(url.match(/(\d+)\s*$/)?.[1]);
  return { url, number: Number.isInteger(number) ? number : null };
};
