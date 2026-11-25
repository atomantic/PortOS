/**
 * The enumerable answer to "what can I actually practice in POST?" — the data
 * behind the Practice Library at `/post/explore`.
 *
 * Before this existed, a test type was only discoverable if it happened to be
 * enabled (the launcher's sidebar lists ONLY enabled drills), if the user opened
 * Drill Config, or if they already knew a URL: the Rhetoric trainer had no link
 * anywhere in the app, and the standalone Wordplay/Morse/Elements modes were
 * reachable only from inside their own tabs.
 *
 * EVERYTHING here is derived, never re-typed: topic groups come from
 * `POST_TOPICS` (server-owned, mirrored into `constants.js`), and the surfaces
 * that aren't POST drill types come from each trainer's mode list (trainerModes.js).
 * That is the point — a page whose job is "nothing is undiscoverable" must not
 * be the one place that has to be remembered when a mode is added.
 *
 * Data only (no JSX, icons carried as NAMES the way `TOPIC_UI` does), so the
 * coverage tests read like data assertions rather than render assertions.
 */

import {
  POST_TOPICS,
  TOPIC_UI,
  DRILL_LABELS,
  DRILL_DESCRIPTIONS,
  DRILL_PRACTICE_LINKS,
} from './constants';
// The trainers own their mode lists; the catalog derives from the same tables
// rather than keeping a second copy. They live in trainerModes.js, not in the
// trainer modules, so listing them never pulls a lazily loaded trainer into
// the POST route chunk.
import {
  RHETORIC_MODES,
  MEMORY_PRACTICE_MODES,
  ELEMENTS_PRACTICE_MODES,
  MORSE_REFERENCE_VIEWS,
} from './trainerModes';
import { tokenizeQuery, matchHaystack } from '../../../lib/mediaSearch.js';

// One line per Morse reference chart. The chart list itself comes from
// MORSE_REFERENCE_VIEWS; only this "what am I looking at" copy is catalog-owned, because
// the trainer's tab bar has room for a one-word label and nothing more.
const MORSE_REFERENCE_DESCRIPTIONS = {
  tree: 'The dichotomic dit/dah binary tree.',
  length: 'Characters grouped by symbol count.',
  list: 'The full character table.',
};

// Badges a catalog entry can carry. Kept as ids (not prose) so the page owns the
// styling and this module stays JSX-free.
export const TAG_LABELS = {
  session: 'In POST sessions',
  standalone: 'Practice on its own',
  ai: 'Needs an AI provider',
  reference: 'Reference',
};

// Where a topic's own tab lives, for topics that have one. A topic absent here
// composes into sessions only, so its group header links at the launcher.
const TOPIC_SURFACE_LINKS = {
  memory: '/post/memory',
  wordplay: '/post/wordplay',
  morse: '/post/morse',
};

function topicEntry(topic, type) {
  const to = DRILL_PRACTICE_LINKS[type] || null;
  const tags = [];
  if (topic.surface === 'session') tags.push('session');
  if (to) tags.push('standalone');
  if (topic.module === 'llm-drills') tags.push('ai');
  return {
    id: type,
    drillType: type,
    label: DRILL_LABELS[type],
    description: DRILL_DESCRIPTIONS[type],
    to,
    tags,
  };
}

const TOPIC_GROUPS = POST_TOPICS.map(topic => ({
  id: topic.id,
  label: topic.label,
  topicId: topic.id,
  description: topic.surface === 'session'
    ? 'Composes into Full POST and Quick sessions.'
    : 'Practiced from its own tab, outside a composed session.',
  icon: TOPIC_UI[topic.id]?.icon,
  color: TOPIC_UI[topic.id]?.color,
  bgColor: TOPIC_UI[topic.id]?.bgColor,
  to: TOPIC_SURFACE_LINKS[topic.id] || null,
  entries: topic.drillTypes.map(type => topicEntry(topic, type)),
}));

// Practice material that is NOT a POST drill type, and therefore has no topic
// registry to derive from. Each group maps the trainer's OWN exported mode list,
// so a mode added to a trainer appears here without touching this file — the
// rot this page exists to prevent (a trainer nobody can find) can't come back
// one mode at a time.
const EXTRA_GROUPS = [
  {
    id: 'rhetoric',
    label: 'Rhetoric',
    description: 'Five prompts per round, a craft checklist, and a self-scored attempt.',
    icon: 'Feather',
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/20',
    to: '/post/rhetoric',
    entries: RHETORIC_MODES.map(mode => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      to: `/post/rhetoric/${mode.id}`,
      tags: ['standalone'],
    })),
  },
  {
    id: 'memorization',
    label: 'Memorization Studio',
    description: 'Study modes for the texts you are committing to memory.',
    icon: 'Library',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20',
    to: '/post/memory',
    entries: [
      { id: 'memory-builder', label: 'Memory Builder', description: 'Add and manage the texts you are memorizing, and see mastery per item.', to: '/post/memory', tags: ['standalone'] },
      // The per-item practice modes live at /post/memory/:itemId/:mode, so they
      // have no static link — the item list is the entry point, which the
      // suffix says out loud.
      ...MEMORY_PRACTICE_MODES.map(mode => ({
        id: mode.id,
        label: mode.label,
        description: `${mode.desc}. Pick a text from Memory Builder.`,
        to: '/post/memory',
        tags: ['standalone'],
      })),
    ],
  },
  {
    id: 'elements',
    label: 'Elements Song',
    description: 'The built-in periodic-table item, with its own study surface.',
    icon: 'Atom',
    color: 'text-lime-400',
    bgColor: 'bg-lime-500/20',
    to: '/post/memory/elements',
    entries: ELEMENTS_PRACTICE_MODES.map(mode => ({
      id: `elements-${mode.id}`,
      label: mode.label,
      description: mode.desc,
      to: `/post/memory/elements/${mode.id}`,
      // element-flash doubles as a scored session drill; the rest are study-only.
      tags: mode.id === 'element-flash' ? ['standalone', 'session'] : ['standalone'],
    })),
  },
  {
    id: 'reference',
    label: 'Reference Charts',
    description: 'Look-up material — nothing is scored here.',
    icon: 'BookMarked',
    color: 'text-slate-300',
    bgColor: 'bg-slate-500/20',
    to: '/post/morse?ref=list',
    entries: MORSE_REFERENCE_VIEWS.map(view => ({
      id: `morse-${view.id}`,
      label: `Morse ${view.label}`,
      description: MORSE_REFERENCE_DESCRIPTIONS[view.id],
      to: `/post/morse?ref=${view.id}`,
      tags: ['reference'],
    })),
  },
];

export const PRACTICE_GROUPS = [...TOPIC_GROUPS, ...EXTRA_GROUPS].map(group => ({
  ...group,
  entries: group.entries.map(entry => ({
    ...entry,
    groupId: group.id,
    groupLabel: group.label,
    search: [entry.label, entry.description, entry.drillType, group.label]
      .filter(Boolean).join(' ').toLowerCase(),
  })),
}));

// POST's section-level surfaces — everything that ISN'T a test. One list, shared
// by the launcher header and the Practice Library's table of contents, each
// filtering out the page it is already on. Before this, the two kept separate
// lists that shipped divergent on day one (different labels for /post/config,
// different subsets). Icons are NAMES; `postIcons.js` resolves them.
export const POST_SECTIONS = [
  { id: 'explore', to: '/post/explore', label: 'Explore', hint: 'Every test type', icon: 'Compass' },
  { id: 'launcher', to: '/post/launcher', label: 'Launcher', hint: 'Start a session', icon: 'Play' },
  { id: 'plan', to: '/post/plan', label: 'Practice Plan', hint: 'Choose what you study', icon: 'ListChecks' },
  { id: 'config', to: '/post/config', label: 'Drill Config', hint: 'Tune difficulty', icon: 'Settings' },
  { id: 'progress', to: '/post/progress', label: 'Progress', hint: 'Trends and streaks', icon: 'TrendingUp' },
  { id: 'history', to: '/post/history', label: 'History', hint: 'Past sessions', icon: 'History' },
];

/** `POST_SECTIONS` minus the page doing the rendering. */
export const otherPostSections = (currentId) => POST_SECTIONS.filter(s => s.id !== currentId);

/**
 * Topic tabs that have a surface of their own (Memory, Wordplay, Morse) — the
 * launcher's per-topic shortcuts, derived from the catalog so a topic that gains
 * a tab gets a shortcut for free.
 */
export const TOPIC_SURFACE_SECTIONS = PRACTICE_GROUPS
  .filter(group => group.topicId && group.to)
  .map(group => ({ id: group.id, to: group.to, label: group.label, hint: group.description, icon: group.icon }));

/**
 * Every catalog entry, flat, with the group it came from and a precomputed
 * lowercase haystack. Built ONCE at module load and shared by reference with
 * `PRACTICE_GROUPS` — so filtering is a set of `includes()` calls with no
 * per-keystroke allocation, and entry identity stays stable across filters.
 */
export const PRACTICE_ENTRIES = PRACTICE_GROUPS.flatMap(group => group.entries);

/** `PRACTICE_GROUPS` with non-matching entries removed and empty groups dropped. */
export function filterPracticeGroups(query) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return PRACTICE_GROUPS;
  return PRACTICE_GROUPS
    .map(group => ({ ...group, entries: group.entries.filter(e => matchHaystack(e.search, tokens)) }))
    .filter(group => group.entries.length > 0);
}
