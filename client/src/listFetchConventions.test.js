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
 * stays honest. The remaining sites are tracked by surface in the follow-up
 * issues #12040 names; the app detail tabs (#12591) are already at zero.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass:
 *   - A catch whose body does more than clear the list (`{ setX([]); setLoading(false); }`)
 *     is not matched; so is a `.catch` passed a named function.
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
 * `.catch(() => { setX([]); })`, and the object-literal spelling
 * `.catch(() => ({ agents: [], summary: {} }))` (a list under a key, one level
 * of nested braces allowed). The setter must start with `set` + a capital, so
 * `.catch(() => reset([]))` and a non-setter call stay out.
 */
export const LIST_COLLAPSE = /\.catch\(\s*\(\s*\)\s*=>\s*(?:\[\]|\{?\s*set[A-Z]\w*\(\s*\[\]\s*\)\s*;?\s*\}?|\(\s*\{(?:[^{}]|\{[^{}]*\})*?\b\w+\s*:\s*\[\](?:[^{}]|\{[^{}]*\})*\}\s*\))\s*\)/g;

/**
 * Files still carrying a collapse, with how many. Lower or remove a row when a
 * site is migrated to `useListResource`; never raise one.
 */
const KNOWN = Object.freeze({
  'src/components/FeatureProviderPicker.jsx': 1,
  'src/components/QuickTaskWidget.jsx': 2,
  'src/components/apps/JiraConfigPanel.jsx': 1,
  'src/components/brain/IdeaLoomLists.jsx': 1,
  'src/components/brain/YoutubeIngestSettings.jsx': 1,
  'src/components/brain/tabs/ConfigTab.jsx': 1,
  'src/components/brain/tabs/DailyLogTab.jsx': 1,
  'src/components/brain/tabs/FeedsTab.jsx': 1,
  'src/components/brain/tabs/TrustTab.jsx': 1,
  'src/components/cos/tabs/JobsTab.jsx': 1,
  'src/components/cos/tabs/ProviderStatusCard.jsx': 1,
  'src/components/cos/tabs/RunsTab.jsx': 1,
  'src/components/digital-twin/ObservedTasteEvidence.jsx': 1,
  'src/components/digital-twin/tabs/AccountsTab.jsx': 3,
  'src/components/digital-twin/tabs/AutobiographyTab.jsx': 3,
  'src/components/digital-twin/tabs/DocumentsTab.jsx': 1,
  'src/components/digital-twin/tabs/EnrichTab.jsx': 1,
  'src/components/digital-twin/tabs/ExportTab.jsx': 2,
  'src/components/digital-twin/tabs/ImportTab.jsx': 2,
  'src/components/digital-twin/tabs/InterviewTab.jsx': 1,
  'src/components/digital-twin/tabs/OverviewTab.jsx': 2,
  'src/components/digital-twin/tabs/PersonalityTab.jsx': 1,
  'src/components/digital-twin/tabs/PersonasTab.jsx': 1,
  'src/components/digital-twin/tabs/TasteTab.jsx': 2,
  'src/components/digital-twin/tabs/TestTab.jsx': 4,
  'src/components/digital-twin/tabs/TimeCapsuleTab.jsx': 1,
  'src/components/fableloom/LoomProductionPanel.jsx': 1,
  'src/components/fableloom/LoomSettingsDrawer.jsx': 1,
  'src/components/loraTraining/CaptionModelPicker.jsx': 1,
  'src/components/meatspace/EpigeneticTracker.jsx': 1,
  'src/components/meatspace/HealthCategorySection.jsx': 1,
  'src/components/meatspace/post/PostSessionLauncher.jsx': 2,
  'src/components/meatspace/post/PracticePlan.jsx': 1,
  'src/components/meatspace/tabs/AlcoholTab.jsx': 1,
  'src/components/meatspace/tabs/NicotineTab.jsx': 1,
  'src/components/meatspace/tabs/PostTab.jsx': 1,
  'src/components/media/UniverseMoodBoardPicker.jsx': 3,
  'src/components/messages/DraftsTab.jsx': 1,
  'src/components/messages/IMessageTab.jsx': 1,
  'src/components/music/AlbumsManager.jsx': 2,
  'src/components/music/ChiptunePanel.jsx': 1,
  'src/components/music/TracksManager.jsx': 2,
  'src/components/pipeline/stages/ComicScriptStage.jsx': 1,
  'src/components/pipeline/stages/NounsStage.jsx': 1,
  'src/components/privacy/PrivacyOrgsTab.jsx': 2,
  'src/components/settings/SharingTab.jsx': 1,
  'src/components/settings/VoiceTab.jsx': 1,
  'src/components/sharing/ShareToButton.jsx': 2,
  'src/components/sharing/SyncToPeerButton.jsx': 1,
  'src/components/sprites/ImportPanel.jsx': 1,
  'src/components/writers-room/AnalysisHistory.jsx': 1,
  'src/components/writers-room/ExercisePanel.jsx': 1,
  'src/components/writers-room/PolishPanel.jsx': 1,
  'src/components/writers-room/StoryboardPanel.jsx': 3,
  'src/pages/AIProviders.jsx': 2,
  'src/pages/PipelineEditorialChecks.jsx': 1,
  'src/pages/PipelineManuscriptEditor.jsx': 1,
  'src/pages/PromptManager.jsx': 1,
  'src/pages/Sharing.jsx': 1,
  'src/pages/Tribe.jsx': 2,
});

const countIn = (source) => (source.match(LIST_COLLAPSE) || []).length;

describe('page list fetches keep a failed read distinct from an empty list', () => {
  it('matches the collapse spellings it is meant to catch, and not a handled failure', () => {
    for (const sample of [
      'listLorasFull().catch(() => [])',
      'listTracks({ silent: true }).then((t) => setTracks(t || [])).catch(() => setTracks([]))',
      'load().catch(() => { setRows([]); })',
      'getAppAgents(id).catch(() => ({ agents: [], summary: {} }))',
      'getBranches(p).catch(() => ({ summary: {}, branches: [] }))',
    ]) expect(countIn(sample), sample).toBe(1);
    for (const sample of [
      'listTracks().catch(() => setLoadError(true))',
      'load().catch(() => { setRows([]); setFailed(true); })',
      'load().catch(() => FETCH_FAILED)',
      'getAppTaskTypes(id).catch(() => ({ taskTypeOverrides: {} }))',
      'load().catch(() => ({ providers: [], error: true }))'.replace('[], error', 'x, error'),
    ]) expect(countIn(sample), sample).toBe(0);
  });

  it('keeps the app detail tabs off the baseline', () => {
    for (const tab of ['TasksTab', 'AutomationTab', 'GitTab']) {
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
      .filter(([file, count]) => count > (KNOWN[file] || 0))
      .map(([file, count]) => `${file}: ${count} (known ${KNOWN[file] || 0})`);
    expect(added, [
      'These list fetches render a failed read as an empty list. Read the list through',
      '`useListResource(fetcher)` and render `<ListLoadError onRetry={retry}>` on `state === "error"`,',
      'keeping the empty copy for `state === "ready"`; never `.catch(() => [])` / `setX([])`.',
    ].join('\n')).toEqual([]);
    const stale = Object.entries(KNOWN)
      .filter(([file, count]) => (found[file] || 0) < count)
      .map(([file, count]) => `${file}: now ${found[file] || 0} (known ${count})`);
    expect(stale, 'A migrated site: lower or remove its KNOWN row so the ratchet holds.').toEqual([]);
  });
});
