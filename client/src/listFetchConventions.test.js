// @vitest-environment node

/**
 * Repo-wide guard: a page or component list fetch does not collapse a failed read into
 * an empty list.
 *
 * `listLorasFull().catch(() => [])` and `.catch(() => setTracks([]))` make a
 * transient 5xx during page load render as "you have none" — no error, no
 * retry, and no way to tell it from an empty library (#12040). The root
 * AGENTS.md sentinel rule (absent vs failed vs legitimately empty) is enforced
 * server-side; this is its client half. The shared primitive is
 * `hooks/useListResource` (`{ items, state, error, retry }`) with
 * `components/ui/ListLoadError` for the failed state.
 *
 * The rule is a ratchet. `KNOWN` records how many such sites each page still
 * carries today; a NEW site, or a higher count in a listed page, fails. So does
 * a count that DROPPED, so the row is lowered or removed and the baseline
 * stays honest. The page sweeps (#12169–#12171) and the app detail tabs
 * (#12591) are done; the remaining component sites are tracked by surface in
 * #12783 (Digital Twin), #12784 (Brain/MeatSpace/Messages/Privacy/Tribe),
 * #12785 (creative panels), #12807 (LoRA training panel) and #12786 (settings/sharing/CoS/providers).
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass. Besides the one-expression spellings it
 * catches the two-step `const x = await read().catch(() => null);` followed,
 * within the next few lines, by `setX(x?.field || [])` with no `!x` /
 * `x === null` check (#12591's sweep missed exactly that shape).
 *
 *   - A catch whose body does more than clear the list after its leading
 *     statements (`{ setX([]); setLoading(false); }`) is not matched; so is a
 *     `.catch` passed a named function.
 *   - A collapse moved into a hook or lib module is invisible (that is also where
 *     a shared, state-carrying read belongs).
 *   - A match inside a comment or string counts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pages (the pickers and index lists users see) and the components they host
// (app detail tabs, drawers, panels).
const SCAN_PREFIXES = ['src/pages/', 'src/components/'];

/**
 * `.catch(() => [])`, `.catch(() => setX([]))`, the braced one-statement form
 * `.catch(() => { setX([]); })` (optionally behind an `if (...)` guard such as
 * `if (!cancelled)`), the keyed-map setter `setX((m) => ({ ...m, [id]: [] }))`
 * (bare or braced), and the object-literal spelling
 * `.catch(() => ({ agents: [], summary: {} }))` (a list under a key, one level
 * of nested braces allowed; an object that also carries an `error` key is a
 * handled failure, not a collapse). A named parameter (`err =>`) and leading
 * statements (`console.warn(...); setX([]);`) are allowed. The setter must start with `set` + a capital, so
 * `.catch(() => reset([]))` and a non-setter call stay out.
 */
const EMPTY_SETTER = String.raw`set[A-Z]\w*\(\s*(?:\[\]|\(\s*\w+\s*\)\s*=>\s*\(\s*\{\s*\.\.\.\w+\s*,\s*\[[^\]]+\]\s*:\s*\[\]\s*\}\s*\))\s*\)`;
// Leading statements of a braced arm, e.g. the `console.warn(...)` in
// `err => { console.warn(...); setX([]); }`. None may call a setter: a catch
// that also records the failure (`setLoadError(err)`) is a handled read.
const LEADING_STATEMENTS = String.raw`(?:(?:(?!\bset[A-Z])(?:[^{};]|\$\{[^{}]*\}))*;\s*)*`;
export const LIST_COLLAPSE = new RegExp(
  String.raw`\.catch\(\s*(?:\(\s*\)|\(\s*\w+\s*\)|\w+)\s*=>\s*(?:\[\]|\{\s*${LEADING_STATEMENTS}(?:if\s*\([^()]*\)\s*)?${EMPTY_SETTER}\s*;?\s*\}|${EMPTY_SETTER}|\(\s*\{(?!(?:[^{}]|\{[^{}]*\})*\berror\b)(?:[^{}]|\{[^{}]*\})*?\b\w+\s*:\s*\[\](?:[^{}]|\{[^{}]*\})*\}\s*\))\s*\)`,
  'g',
);

/**
 * Files still carrying a collapse, with how many. Lower or remove a row when a
 * site is migrated to `useListResource`; never raise one.
 */
const KNOWN = Object.freeze({});

/**
 * Sites that match on purpose, each with the reason it is not a list collapse.
 * They are not ratcheted down: the count is the number of intentional matches.
 */
const EXEMPT = Object.freeze({
  // Epic-name typeahead: a failed search shows no suggestions, the typed key is
  // validated separately (`epicValidation`), and nothing says "no epics exist".
  'src/components/apps/JiraConfigPanel.jsx': 1,
  // `canDelete: true` on a failed usage read lets the server's own
  // SYSTEM_STAGE_PROTECTED guard answer. The empty `usedBy`/`referencedBy` feed
  // a delete-confirm prompt, not a library listing, so no "you have none" copy.
  'src/pages/PromptManager.jsx': 1,
  // Canon-entity linkify lookup: a failed universe read just shows no entity chips
  // on findings (the findings themselves render, and nothing says "no canon exists");
  // nothing writes from it.
  'src/pages/PipelineEditorialChecks.jsx': 1,
  // Tag typeahead: a failed lookup shows no suggestions, freeform tags are accepted
  // regardless (the server normalizes and creates the canonical row on save), and
  // nothing says "no tags exist" or writes from the suggestion list.
  'src/components/TagPicker.jsx': 1,
});

const allowedIn = (file) => (KNOWN[file] || 0) + (EXEMPT[file] || 0);

const NULL_CATCH_READ = /const\s+(\w+)\s*=\s*await\s+[^;]*?\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)\s*;/g;
const TWO_STEP_WINDOW_LINES = 6;

/** The two-step collapse: a null-on-failure read whose list is then defaulted to `[]`. */
const countTwoStepIn = (source) => {
  let count = 0;
  for (const match of source.matchAll(NULL_CATCH_READ)) {
    const name = match[1];
    const after = source.slice(match.index + match[0].length).split('\n').slice(0, TWO_STEP_WINDOW_LINES + 1).join('\n');
    const defaultsToEmpty = new RegExp(String.raw`set[A-Z]\w*\(\s*\(?\s*${name}\?\.[\w?.]+\s*(?:\|\||\?\?)\s*\[\]`).test(after)
      || new RegExp(String.raw`\(\s*${name}\?\.[\w?.]+\s*(?:\|\||\?\?)\s*\[\]\s*\)\s*\.(?:filter|map|slice)\(`).test(after);
    const handlesFailure = new RegExp(String.raw`!\s*${name}\b|\b${name}\s*===?\s*null\b`).test(after);
    if (defaultsToEmpty && !handlesFailure) count += 1;
  }
  return count;
};

const countIn = (source) => (source.match(LIST_COLLAPSE) || []).length + countTwoStepIn(source);

describe('page list fetches keep a failed read distinct from an empty list', () => {
  it('matches the collapse spellings it is meant to catch, and not a handled failure', () => {
    for (const sample of [
      'listLorasFull().catch(() => [])',
      'listTracks({ silent: true }).then((t) => setTracks(t || [])).catch(() => setTracks([]))',
      'load().catch(() => { setRows([]); })',
      'getAppAgents(id).catch(() => ({ agents: [], summary: {} }))',
      'getBranches(p).catch(() => ({ summary: {}, branches: [] }))',
      'getJiraBoards(i).catch(() => { if (!cancelled) setBoards([]); })',
      'listShareInbox(id).catch(() => setInboxByBucket((m) => ({ ...m, [bucketId]: [] })))',
      'getUniverses().catch(err => { console.warn(`⚠️ Failed: ${err.message}`); setUniverses([]); })',
      'getChunks().catch(err => {\n        console.warn(\'x: \' + err.message);\n        if (active) setChunkMastery([]);\n      })',
      'listCheckpoints(id).catch((e) => setCheckpoints([]))',
      'listShareActivity(id).catch(() => { setActivityByBucket((m) => ({ ...m, [id]: [] })); })',
      'const data = await api.getSubmodules(p, { silent: true }).catch(() => null);\n    setSubmodules(data?.submodules || []);',
      'const data = await api.getCosJobs().catch(() => null);\n    const mine = (data?.jobs || []).filter(j => j.appId === id);\n    setTasks(mine);',
    ]) expect(countIn(sample), sample).toBe(1);
    for (const sample of [
      'listTracks().catch(() => setLoadError(true))',
      'load().catch(() => { setRows([]); setFailed(true); })',
      'load().catch(() => FETCH_FAILED)',
      'getAppTaskTypes(id).catch(() => ({ taskTypeOverrides: {} }))',
      'load().catch(() => { if (!cancelled) { setRows([]); setFailed(true); } })',
      'load().catch(() => setInboxByBucket((m) => ({ ...m, [bucketId]: m[bucketId] })))',
      'load().catch(err => { console.warn(err.message); setRows([]); setLoadError(err); })',
      'load().catch(err => { setLoadError(err); setRows([]); })',
      'load().catch(error => ({ key, data: [], error }))',
      'load().catch((err) => ({ error: err.message, posts: [] }))',
      'load().catch(() => ({ providers: [], error: true }))'.replace('[], error', 'x, error'),
      'const data = await api.getReadings().catch(() => null);\n    setFailed(data === null);\n    setReadings(data?.readings || []);',
      'const data = await api.getSubmodules(p).catch(() => null);\n    if (!data) { setLoadError(true); return; }\n    setSubmodules(data.submodules || []);',
      'const result = await api.startApp(id).catch(() => null);\n    if (result?.ok) toast.success(`Started`);',
    ]) expect(countIn(sample), sample).toBe(0);
  });

  it('keeps the app detail tabs off the baseline', () => {
    for (const tab of ['TasksTab', 'AutomationTab', 'GitTab', 'GsdTab', 'SubmodulesTab', 'CustomTasksSection']) {
      expect(KNOWN, tab).not.toHaveProperty(['src/components/apps/tabs/' + tab + '.jsx']);
    }
  });

  it('has no new page or component list fetch that collapses failure into an empty list', () => {
    const found = {};
    for (const file of trackedSourceFiles(CLIENT_ROOT)) {
      if (!SCAN_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
      const count = countIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
      if (count > 0) found[file] = count;
    }
    const added = Object.entries(found)
      .filter(([file, count]) => count > allowedIn(file))
      .map(([file, count]) => `${file}: ${count} (known ${allowedIn(file)})`);
    expect(added, [
      'These list fetches render a failed read as an empty list. Read the list through',
      '`useListResource(fetcher)` and render `<ListLoadError onRetry={retry}>` on `state === "error"`,',
      'keeping the empty copy for `state === "ready"`; never `.catch(() => [])` / `setX([])`.',
    ].join('\n')).toEqual([]);
    const stale = Object.keys({ ...KNOWN, ...EXEMPT })
      .filter((file) => (found[file] || 0) < allowedIn(file))
      .map((file) => `${file}: now ${found[file] || 0} (known ${allowedIn(file)})`);
    expect(stale, 'A migrated site: lower or remove its KNOWN row so the ratchet holds.').toEqual([]);
  });
});
