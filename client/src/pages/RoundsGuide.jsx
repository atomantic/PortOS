/**
 * Rounds Guide — deep-linkable learning reference at /rounds/guide.
 *
 * Renders directly from the canonical reference data in lib/songCraft.js so the
 * dirge rhythm shapes, the foundation-first layer ladder, the practice
 * sequence, and the notation primers stay in sync with the Song editor's
 * pickers (which read the same arrays). The parent <main> is full-width /
 * overflow-hidden (Layout.jsx isFullWidth matches `/rounds/`), so this page owns
 * its own vertical scroll — mirrors WritersRoomGuide.
 */

import { Link } from 'react-router-dom';
import { Music, ArrowLeft, Drum, Layers, GraduationCap, FileMusic } from 'lucide-react';
import Pill from '../components/ui/Pill';
import {
  RHYTHM_SHAPES,
  DIRGE_RHYTHM_SHAPES,
  VOICE_LAYERS,
  LEARNING_STEPS,
  NOTATION_HELP,
  SOLFEGE_DEGREES,
  solfegeForDegree,
} from '../lib/songCraft';

// Dirges lead the rhythm list (the workbench's home turf), then the rest.
const NON_DIRGE_SHAPES = RHYTHM_SHAPES.filter((s) => !s.dirge);
const ORDERED_RHYTHM_SHAPES = [...DIRGE_RHYTHM_SHAPES, ...NON_DIRGE_SHAPES];

function RhythmCard({ shape }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white">{shape.label}</span>
        {shape.dirge && <Pill tone="accent" size="xs">dirge</Pill>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Pill tone="muted">{shape.bpm.label}</Pill>
        <Pill tone="note">{shape.count}</Pill>
      </div>
      <p className="text-xs text-gray-300 leading-relaxed">{shape.feel}</p>
      <p className="text-xs text-gray-500 leading-relaxed">{shape.note}</p>
    </div>
  );
}

function LayerCard({ layer }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-port-accent/15 text-port-accent text-[11px] font-bold shrink-0">
          {layer.order}
        </span>
        <span className="text-sm font-semibold text-white">{layer.label}</span>
        <Pill tone="muted" size="xs">{layer.voices}</Pill>
      </div>
      <p className="text-xs text-gray-300 leading-relaxed mb-1">{layer.role}</p>
      <p className="text-xs text-gray-500 leading-relaxed">{layer.advice}</p>
    </div>
  );
}

function SectionHeading({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Icon size={18} className="text-port-accent" />
        {title}
      </h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

export default function RoundsGuide() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-port-border bg-port-card shrink-0">
        <Link
          to="/rounds"
          className="p-1 text-gray-400 hover:text-white transition-colors"
          title="Back to Rounds"
          aria-label="Back to Rounds"
        >
          <ArrowLeft size={18} />
        </Link>
        <Music size={18} className="text-port-accent shrink-0" />
        <span className="text-white font-semibold">Rounds · Learning Guide</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-4xl mx-auto space-y-10">
          <p className="text-sm text-gray-400 leading-relaxed">
            How to write and learn a cappella songs — the slow lament family (dirges and
            ballads like <span className="text-gray-200">"500 Miles"</span>), how to stack
            harmony layers, the practice sequence, and a plain-language notation primer.
          </p>

          {/* Rhythm shapes */}
          <section>
            <SectionHeading
              icon={Drum}
              title="Rhythm shapes"
              subtitle="The felt pulse a song leans on. Dirges — slow, solemn laments — lead the list, since that's the workbench's home turf."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ORDERED_RHYTHM_SHAPES.map((s) => <RhythmCard key={s.id} shape={s} />)}
            </div>
          </section>

          {/* Layer ladder */}
          <section>
            <SectionHeading
              icon={Layers}
              title="Building layers (foundation-first)"
              subtitle="Stack voices in this order. Each layer needs the one below it locked and in tune before it can sit right."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {VOICE_LAYERS.map((l) => <LayerCard key={l.id} layer={l} />)}
            </div>
          </section>

          {/* Learning sequence */}
          <section>
            <SectionHeading
              icon={GraduationCap}
              title="How to learn a new song"
              subtitle="A practice sequence — listen and own the melody before you ever touch a harmony."
            />
            <ol className="space-y-2">
              {LEARNING_STEPS.map((step, i) => (
                <li key={step.id} className="bg-port-card border border-port-border rounded-lg p-3 flex gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-port-accent/15 text-port-accent text-xs font-bold shrink-0">
                    {i + 1}
                  </span>
                  <div>
                    <span className="text-sm font-semibold text-white">{step.label}</span>
                    <p className="text-xs text-gray-400 leading-relaxed mt-0.5">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Notation help */}
          <section>
            <SectionHeading
              icon={FileMusic}
              title="Reading musical notation"
              subtitle="A plain-language primer for lead sheets, time signatures, note values, and dynamics."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {NOTATION_HELP.map((g) => (
                <div key={g.id} className="bg-port-card border border-port-border rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-white">{g.title}</h3>
                  <p className="text-xs text-gray-500 mb-2">{g.summary}</p>
                  <ul className="space-y-1.5">
                    {g.points.map((point, i) => (
                      <li key={i} className="flex gap-2 text-xs text-gray-300 leading-relaxed">
                        <span className="text-port-accent shrink-0">›</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* Movable-do solfège ladder — how harmony parts name their home
                degree relative to the tonic (Do). The octave repeats Do. */}
            <div className="bg-port-card border border-port-border rounded-lg p-4 mt-3">
              <h3 className="text-sm font-semibold text-white">Solfège — naming the scale</h3>
              <p className="text-xs text-gray-500 mb-3">
                Movable-do: sing degrees relative to the key's tonic (Do). Find a harmony part by
                its degree above the lead — a third is Mi, a fifth is Sol.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SOLFEGE_DEGREES.map((d) => (
                  <Pill key={d.degree} tone={d.degree === 1 ? 'accent' : 'muted'}>
                    {d.degree}. {d.solfege}
                  </Pill>
                ))}
                {/* The octave folds back to the tonic — solfegeForDegree wraps. */}
                <Pill tone="note">8. {solfegeForDegree(8)} (octave)</Pill>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
