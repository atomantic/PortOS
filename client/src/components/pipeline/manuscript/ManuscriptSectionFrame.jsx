/**
 * Shared chrome for one manuscript section — the sticky title bar (issue +
 * stage), the save badge, and the collapsible version history with one-click
 * revert. The editing surface itself (Live overlay or Review prose) is passed in
 * as children; `headerExtra` lets a mode add controls beside the title (e.g. an
 * Edit toggle).
 */

import { useState } from 'react';
import {
  Loader2, History, RotateCcw, WandSparkles, Sparkles,
} from 'lucide-react';
import { timeAgo } from '../../../utils/formatters';
import { REFLOW_STAGES } from '../../../lib/manuscriptFormat';
import { STAGE_LABEL } from './constants';

function SaveBadge({ state }) {
  if (state === 'saving') return <span className="text-[10px] text-gray-500 inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> saving</span>;
  if (state === 'saved') return <span className="text-[10px] text-port-success">saved</span>;
  return null;
}

export default function ManuscriptSectionFrame({ section, saveState, onRevert, onFormat, onReformat, headerExtra, registerRef, children }) {
  const [showVersions, setShowVersions] = useState(false);
  const [revertingId, setRevertingId] = useState(null);
  const [formatting, setFormatting] = useState(false);
  const [reformatting, setReformatting] = useState(false);
  const versions = section.versions || [];

  const revert = async (runId) => {
    setRevertingId(runId);
    await onRevert(runId);
    setRevertingId(null);
  };

  const format = async () => {
    setFormatting(true);
    try {
      await onFormat();
    } finally {
      setFormatting(false);
    }
  };

  const reformat = async () => {
    setReformatting(true);
    try {
      await onReformat();
    } finally {
      setReformatting(false);
    }
  };

  // Prose reflows into paragraphs; scripts only get safe artifact cleanup.
  const formatTitle = REFLOW_STAGES.has(section.stageId)
    ? 'Clean up formatting — fix pasted-PDF artifacts (drop-caps, hyphen splits) and reflow hard-wrapped lines into paragraphs'
    : 'Clean up formatting — fix pasted-PDF artifacts (drop-caps, hyphen splits, stray blank lines) while keeping the script\'s line breaks';

  return (
    <article ref={registerRef} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 sticky top-0 bg-port-bg/95 backdrop-blur py-1 z-10">
        <h2 className="text-sm font-semibold text-gray-200">
          Issue {section.number}{section.title ? ` — ${section.title}` : ''}
          <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-500">{STAGE_LABEL[section.stageId] || section.stageId}</span>
        </h2>
        <div className="flex items-center gap-2">
          {onFormat ? (
            <button
              type="button"
              // Don't steal focus from an active section textarea: a plain click
              // would blur it first, firing onBlurSave with the PRE-format text,
              // and that save can land after the format save (HTTP order isn't
              // guaranteed), persisting stale content. Preventing the blur means
              // only the format save runs — and the controlled textarea has
              // already written every keystroke to state, so no edits are lost.
              onMouseDown={(e) => e.preventDefault()}
              onClick={format}
              disabled={formatting}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-port-border text-gray-300 hover:text-white hover:border-port-accent/40 disabled:opacity-40"
              title={formatTitle}
            >
              {formatting ? <Loader2 size={11} className="animate-spin" /> : <WandSparkles size={11} />}
              Format
            </button>
          ) : null}
          {onReformat ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={reformat}
              disabled={reformatting}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-port-border text-port-accent hover:text-white hover:border-port-accent/40 disabled:opacity-40"
              title="Reformat with AI — fixes paste artifacts the plain Format can't (scrambled/duplicated quotes, ambiguous wraps) using the AI provider selected in the sidebar. Never changes your words; revertible via history."
            >
              {reformatting ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              Reformat (AI)
            </button>
          ) : null}
          {headerExtra}
          <SaveBadge state={saveState} />
          {versions.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowVersions((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white"
              title="Show prior saved versions"
            >
              <History size={12} /> {versions.length}
            </button>
          ) : null}
        </div>
      </div>

      {showVersions && versions.length > 0 ? (
        <div className="border border-port-border rounded bg-port-bg/40 p-2 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Version history (newest first)</p>
          {versions.map((v) => (
            <div key={v.runId} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-gray-400">{v.createdAt ? timeAgo(v.createdAt) : v.runId}</span>
              <button
                type="button"
                onClick={() => revert(v.runId)}
                disabled={revertingId === v.runId}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-gray-300 hover:text-white border border-port-border hover:border-port-accent/40 disabled:opacity-40"
                title="Revert this section to that version (reversible)"
              >
                {revertingId === v.runId ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                Revert
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {children}
    </article>
  );
}
