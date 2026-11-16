/**
 * Pure `gh`/`glab` issue-filing argument shapes and output parsing — `forgeLabelCreateArgs`,
 * `forgeIssueCreateArgs`, `parseCreatedForgeIssue` — so the two CLIs' disagreements have one definition.
 *
 * They differ on the body flag (`--body` vs `--description`), label attachment (repeated `--label` vs
 * one comma-joined value) and label creation (gh: positional name, bare hex color; glab: `--name`,
 * `#`-prefixed color). No child-process or network access; callers own the exec.
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
 * The created issue's `{ url, number }` from `issue create` stdout. `number` is null when the trailing
 * segment isn't numeric and `url` falls back to the raw stdout: the issue exists either way, so an
 * unparseable line must not become a reported failure.
 */
export const parseCreatedForgeIssue = (stdout) => {
  const text = String(stdout || '').trim();
  const url = text.match(/(https?:\/\/\S+)/)?.[1] || text;
  const number = Number(url.match(/(\d+)\s*$/)?.[1]);
  return { url, number: Number.isInteger(number) ? number : null };
};
