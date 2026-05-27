import { Link } from 'react-router-dom';
import { NotebookPen, ArrowLeft, Ruler, BookOpen, Lightbulb, Sparkles } from 'lucide-react';
import {
  WRITING_LENGTH_TARGETS,
  BOOK_LENGTH_ESTIMATES,
  WRITING_PRINCIPLES,
  PLANNED_ANALYSES,
} from '../lib/writingGuide';
import Pill from '../components/ui/Pill';

// Writers Room Guide — deep-linkable docs at /writers-room/guide. Renders from
// the canonical reference data in lib/writingGuide.js so length targets stay in
// sync with the editor features that will eventually enforce them. The parent
// <main> is full-width/overflow-hidden (see Layout.jsx isFullWidth), so this
// page owns its own vertical scroll.

function LengthCard({ target }) {
  // A chapter band with null bounds means the form is read in one sitting; render
  // it muted/italic to keep it visually distinct from real numeric targets.
  const chapterTone = target.chapters.min == null && target.chapters.max == null
    ? 'note'
    : 'muted';
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white">{target.label}</span>
        {!target.core && (
          <Pill tone="context" size="xs">context</Pill>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Pill tone="accent">{target.words.label}</Pill>
        <Pill>{target.chars.label}</Pill>
        <Pill>{target.pages.label}</Pill>
        <Pill tone={chapterTone}>{target.chapters.label}</Pill>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed">{target.note}</p>
    </div>
  );
}

function PrincipleCard({ group }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-white">{group.title}</h3>
      <p className="text-xs text-gray-500 mb-3">{group.summary}</p>
      <ul className="space-y-2">
        {group.rules.map((rule, i) => (
          <li key={i} className="flex gap-2 text-xs text-gray-300 leading-relaxed">
            <span className="text-port-accent shrink-0">›</span>
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function WritersRoomGuide() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-port-border bg-port-card shrink-0">
        <Link
          to="/writers-room"
          className="p-1 text-gray-400 hover:text-white transition-colors"
          title="Back to Writers Room"
          aria-label="Back to Writers Room"
        >
          <ArrowLeft size={18} />
        </Link>
        <NotebookPen className="w-5 h-5 text-port-accent" />
        <h1 className="text-xl font-bold text-white">Writers Room Guide</h1>
        <span className="text-xs text-gray-500 hidden md:inline ml-auto">
          Length targets, craft principles, and the analyses we apply to your prose
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-6">
        <div className="max-w-5xl mx-auto space-y-10">
          <p className="text-sm text-gray-400 leading-relaxed max-w-3xl">
            A working reference for the forms you write in and the craft rules the editor leans on.
            The length bands below are the same numbers our analysis passes will use to tell you when
            a draft is drifting under- or over-length for its category — see what is planned at the
            bottom of this page.
          </p>

          {/* Length targets */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Ruler className="w-5 h-5 text-port-accent" />
              <h2 className="text-lg font-bold text-white">Length Targets by Form</h2>
            </div>
            <p className="text-xs text-gray-500 max-w-3xl">
              Word counts are the primary signal; character counts assume the conventional English
              estimate of ~5–6 characters per word (≈5 letters + a space). Page counts assume the
              conventional ~250–300 words per printed page, and chapter counts assume ~3,000–5,000
              words per chapter (forms read in one sitting list no chapter target). Bands have
              small gaps between named forms — a draft that lands in a gap rounds up to the next
              form.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {WRITING_LENGTH_TARGETS.map((target) => (
                <LengthCard key={target.id} target={target} />
              ))}
            </div>
          </section>

          {/* Book length estimates */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-port-accent" />
              <h2 className="text-lg font-bold text-white">Book-Length Estimates</h2>
            </div>
            <p className="text-xs text-gray-500 max-w-3xl">
              A printed page holds roughly 250–300 words depending on trim size, font, margins, and
              genre. These are planning estimates, not guarantees.
            </p>
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-sm border border-port-border rounded-lg overflow-hidden">
                <thead className="bg-port-bg text-gray-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Book length</th>
                    <th className="text-left font-medium px-3 py-2">Words / page</th>
                    <th className="text-left font-medium px-3 py-2">Approx. words</th>
                    <th className="text-left font-medium px-3 py-2">Approx. characters</th>
                  </tr>
                </thead>
                <tbody>
                  {BOOK_LENGTH_ESTIMATES.map((row) => (
                    <tr key={row.id} className="border-t border-port-border bg-port-card">
                      <td className="px-3 py-2 font-semibold text-white whitespace-nowrap">{row.label}</td>
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{row.wordsPerPage}</td>
                      <td className="px-3 py-2 text-port-accent whitespace-nowrap">{row.words.label}</td>
                      <td className="px-3 py-2 text-gray-300 whitespace-nowrap">{row.chars.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Craft principles */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-port-accent" />
              <h2 className="text-lg font-bold text-white">Craft Principles</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {WRITING_PRINCIPLES.map((group) => (
                <PrincipleCard key={group.id} group={group} />
              ))}
            </div>
          </section>

          {/* Analyses */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-port-accent" />
              <h2 className="text-lg font-bold text-white">Editor Analyses</h2>
            </div>
            <p className="text-xs text-gray-500 max-w-3xl">
              As the editor grows, these passes will evaluate your story and apply the rules above.
              Each reads the same length and craft data shown on this page.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {PLANNED_ANALYSES.map((item) => (
                <div key={item.id} className="bg-port-card border border-port-border rounded-lg p-4">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                    <Pill tone="bare" size="xs" className="uppercase tracking-wide text-port-warning border-port-warning/30 bg-port-warning/10">
                      {item.status}
                    </Pill>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">{item.summary}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
