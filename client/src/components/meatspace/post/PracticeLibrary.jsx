import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ArrowRight, Compass, Search } from 'lucide-react';
import Pill from '../../ui/Pill';
import { filterPracticeGroups, otherPostSections, PRACTICE_ENTRIES, TAG_LABELS } from './practiceCatalog';
import { postIcon } from './postIcons';
import { composedSessionDrillTypes } from './constants';

// The rest of POST, minus this page — rendered as a quick-links row so the
// Practice Library doubles as the section's table of contents.
const SECTIONS = otherPostSections('explore');

const TAG_TONE = { session: 'muted', standalone: 'accent', ai: 'warning', reference: 'note' };

// Memoized: entry identity is stable across filter calls (the catalog builds each
// entry once at module load), so a keystroke re-renders only the cards whose
// membership actually changed rather than all ~55.
const EntryCard = memo(function EntryCard({ entry, inPlan }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-white">{entry.label}</span>
        {entry.to && <ArrowRight size={14} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-port-accent" />}
      </div>
      {entry.description && <p className="mt-1 text-xs text-gray-400">{entry.description}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {entry.tags.map(tag => (
          <Pill key={tag} tone={TAG_TONE[tag] || 'context'} size="xs">{TAG_LABELS[tag] || tag}</Pill>
        ))}
        {inPlan && <Pill tone="success" size="xs">In your plan</Pill>}
      </div>
    </>
  );
  const shell = 'block text-left bg-port-bg border border-port-border rounded-lg p-3 min-w-0';
  // Session-only drills have no standalone surface to open — they run inside a
  // composed session — so they render as a plain card, not a dead link.
  if (!entry.to) return <div className={shell}>{body}</div>;
  return (
    <Link to={entry.to} className={`${shell} group hover:border-port-accent/60 transition-colors`}>
      {body}
    </Link>
  );
});

/**
 * `/post/explore` — one browsable page listing every POST test type and every
 * piece of practice material, grouped by topic, with a direct link wherever a
 * standalone surface exists (issue: POST navigation audit).
 */
export default function PracticeLibrary({ config, onBack }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => filterPracticeGroups(query), [query]);
  // Which session drills the user's saved plan would actually run today, so the
  // catalog can distinguish "exists" from "you have it switched on". Keyed on
  // config, not on the query, so typing doesn't re-walk the topic registry.
  const planned = useMemo(
    () => new Set(Object.values(composedSessionDrillTypes(config)).flat()),
    [config],
  );

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <button aria-label="Back" onClick={onBack} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-port-card transition-colors shrink-0">
            <ArrowLeft size={20} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <Compass size={22} className="text-port-accent" />
              <h2 className="text-xl font-bold text-white">Practice Library</h2>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Every test and study surface POST offers — {PRACTICE_ENTRIES.length} in total. Switch what runs in your daily
              session under <Link to="/post/plan" className="text-port-accent hover:underline">Practice Plan</Link>.
            </p>
          </div>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <label htmlFor="practice-library-search" className="sr-only">Search practice</label>
          <input
            id="practice-library-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tests and practice…"
            className="w-full bg-port-card border border-port-border rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
          />
        </div>
      </div>

      {/* Section table of contents — the rest of POST, one click away. */}
      <nav aria-label="POST sections" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {SECTIONS.map(({ to, label, icon, hint }) => {
          const Icon = postIcon(icon);
          return (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2 px-3 py-2 bg-port-card border border-port-border rounded-lg hover:border-port-accent/60 transition-colors min-w-0"
          >
            <Icon size={16} className="shrink-0 text-port-accent" />
            <span className="min-w-0">
              <span className="block text-sm text-white truncate">{label}</span>
              <span className="block text-xs text-gray-500 truncate">{hint}</span>
            </span>
          </Link>
          );
        })}
      </nav>

      {groups.length === 0 && (
        <p className="text-sm text-gray-500">Nothing matches “{query}”.</p>
      )}

      {groups.map(group => {
        const Icon = postIcon(group.icon);
        return (
          <section key={group.id} className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`rounded-lg p-1.5 ${group.bgColor || 'bg-port-bg'}`}>
                  <Icon size={16} className={group.color || 'text-port-accent'} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white">{group.label}</h3>
                  <p className="text-xs text-gray-500">{group.description}</p>
                </div>
              </div>
              {group.to && (
                <Link to={group.to} className="flex items-center gap-1 text-xs text-port-accent hover:underline shrink-0">
                  Open {group.label} <ArrowRight size={12} />
                </Link>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {group.entries.map(entry => (
                <EntryCard key={entry.id} entry={entry} inPlan={!!entry.drillType && planned.has(entry.drillType)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
