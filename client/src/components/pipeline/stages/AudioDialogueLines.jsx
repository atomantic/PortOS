import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Sparkles, Wand2 } from 'lucide-react';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import toast from '../../ui/Toast';
import VoicePicker from '../../voice/VoicePicker';
import SpokenCheckChip, { countLinesNeedingListen } from '../SpokenCheckChip';
import {
  extractPipelineAudioLines,
  renderPipelineAudioLine,
  patchPipelineAudioLine,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/apiPipeline.js';

export default function AudioDialogueLines({ issue, stage, onStageUpdate, children }) {
  const lines = Array.isArray(stage.lines) ? stage.lines : [];
  const needListenCount = countLinesNeedingListen(lines);
  const [extracting, setExtracting] = useState(false);
  const [confirmingExtract, setConfirmingExtract] = useState(false);
  const [extractionRevision, setExtractionRevision] = useState(0);

  const storyboardSceneCount = (issue.stages?.storyboards?.scenes || []).length;
  const canExtract = storyboardSceneCount > 0;

  const handleExtract = () => {
    if (!canExtract) {
      toast.error('Generate Storyboards first — audio lines come from the dialogue extracted there.');
      return;
    }
    if (lines.length > 0) {
      setConfirmingExtract(true);
      return;
    }
    void runExtract();
  };

  const runExtract = async () => {
    const needsConfirm = lines.length > 0;
    setConfirmingExtract(false);
    setExtracting(true);
    const result = await extractPipelineAudioLines(issue.id, { force: needsConfirm }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Extract failed');
      return null;
    });
    setExtracting(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    setExtractionRevision((value) => value + 1);
    const preserved = result.preservedCount || 0;
    if (preserved > 0) {
      toast.success(`Extracted ${result.lineCount} line${result.lineCount === 1 ? '' : 's'} · preserved ${preserved} rendered`);
    } else {
      toast.success(`Extracted ${result.lineCount} line${result.lineCount === 1 ? '' : 's'}`);
    }
  };

  return (
    <>
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Mic className="w-5 h-5 shrink-0 text-port-accent" />
          <div className="min-w-0 flex-1 basis-40">
            <h2 className="text-lg font-semibold text-white">{PIPELINE_STAGE_LABELS.audio}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Voice-over per dialogue line. Picks each character's bound voice; falls back to project default.
              {' '}<span className="text-gray-600">Local Piper voices available after setup.</span>
            </p>
          </div>
          <span className={`text-[10px] uppercase tracking-wider ${STATUS_COLOR[stage.status] || 'text-gray-500'}`}>
            {STATUS_LABEL[stage.status] || stage.status}
          </span>
          {lines.length > 0 ? (
            <span className="text-xs text-gray-500">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
          ) : null}
          {needListenCount > 0 ? (
            <span className="text-xs text-port-warning">
              {needListenCount} of {lines.length} line{lines.length === 1 ? '' : 's'} need a listen
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting || !canExtract}
            title={canExtract
              ? (lines.length > 0
                ? 'Replace lines with a fresh extraction from storyboards (rendered audio carried forward for unchanged lines)'
                : 'Walk storyboards dialogue and create one VO line per spoken line')
              : 'Generate Storyboards first — audio lines come from the dialogue extracted there'}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
          >
            {extracting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {lines.length > 0 ? 'Re-extract from storyboards' : 'Extract lines from storyboards'}
          </button>
        </div>
      </header>

      {confirmingExtract && (
        <InlineConfirmRow
          tone="warning"
          question={`Replace ${lines.length} existing line${lines.length === 1 ? '' : 's'} with a fresh extract? Rendered audio is preserved for unchanged lines.`}
          confirmText="Replace"
          onConfirm={() => void runExtract()}
          onCancel={() => setConfirmingExtract(false)}
        />
      )}
      {children}
      {lines.length === 0 ? (
        <p className="text-sm text-gray-400 italic">
          {canExtract
            ? 'No lines yet. Click Extract above to pull dialogue from the storyboards stage.'
            : 'Generate the Storyboards stage first — the dialogue lines there populate this table.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {lines.map((line, index) => (
            <AudioDialogueLine key={`${extractionRevision}:${line.id || index}`} issueId={issue.id}
              line={line} index={index} onStageUpdate={onStageUpdate} />
          ))}
        </ul>
      )}
    </>
  );
}

function AudioDialogueLine({ issueId, line, index, onStageUpdate }) {
  const [drafts, setDrafts] = useState({});
  const [rendering, setRendering] = useState(false);
  const latestLine = useRef(line);
  const pendingSaves = useRef(new Set());
  const pendingDrafts = useRef(new Map());

  useEffect(() => { latestLine.current = line; }, [line]);

  const setDraft = (field, value) => {
    // An older completion can only clear the exact edit it saved.
    setDrafts((current) => ({ ...current, [field]: { value } }));
  };

  const saveLinePatch = (patch) => {
    // Order writes within the row so an earlier edit can't arrive after a later one.
    const promise = Promise.all(pendingSaves.current)
      .then(async () => {
        const updated = await patchPipelineAudioLine(issueId, index, patch, { silent: true });
        if (!updated) return false;
        latestLine.current = updated.stage?.lines?.[index] ?? { ...latestLine.current, ...patch };
        onStageUpdate?.('audio', updated.stage, updated.issue);
        return true;
      })
      .catch((err) => { toast.error(err.message || 'Save failed'); return false; })
      .finally(() => pendingSaves.current.delete(promise));
    pendingSaves.current.add(promise);
    return promise;
  };

  const saveDraft = (field) => {
    const draft = drafts[field];
    if (!draft) return true;
    if (pendingDrafts.current.has(draft)) return pendingDrafts.current.get(draft);

    const dropDraft = () => setDrafts((current) => current[field] === draft
      ? { ...current, [field]: undefined }
      : current);
    const value = field === 'offsetSec' ? (draft.value === '' ? null : Number(draft.value)) : draft.value;
    const { text, offsetSec } = latestLine.current;
    const current = field === 'offsetSec' ? (Number.isFinite(offsetSec) ? offsetSec : null) : (text ?? '');
    const invalidOffset = field === 'offsetSec' && value !== null && (!Number.isFinite(value) || value < 0);
    if (invalidOffset || (value === current && pendingSaves.current.size === 0)) {
      dropDraft();
      return true;
    }

    const save = saveLinePatch({ [field]: value }).then((saved) => {
      pendingDrafts.current.delete(draft);
      if (saved) dropDraft();
      return saved;
    });
    pendingDrafts.current.set(draft, save);
    return save;
  };

  const handleAcceptSpoken = () => {
    const heard = line.verification?.heard;
    if (heard) void saveLinePatch({ expectedSpeech: heard });
  };

  const handleRender = async () => {
    if (rendering) return;
    setRendering(true);
    try {
      // A click can follow blur before its PATCH settles. Reuse that save and
      // flush any remaining drafts before the server reads the line for synthesis.
      const saved = await Promise.all([...pendingSaves.current, saveDraft('text'), saveDraft('offsetSec')]);
      if (!saved.every(Boolean)) return;
      const result = await renderPipelineAudioLine(issueId, index, undefined, { silent: true });
      if (!result) return;
      if (result.issue) onStageUpdate?.('audio', result.issue.stages.audio, result.issue);
      toast.success(`Rendered line ${index + 1} (${result.engine})`);
    } catch (err) {
      toast.error(err.message || 'Render failed');
    } finally {
      setRendering(false);
    }
  };

  const textValue = drafts.text?.value ?? line.text ?? '';
  const offsetValue = drafts.offsetSec?.value ?? (Number.isFinite(line.offsetSec) ? line.offsetSec : '');

  return (
    <li className="p-3 bg-port-card border border-port-border rounded-lg">
      <div className="flex flex-col gap-3 @min-[32rem]/audio-stage:flex-row @min-[32rem]/audio-stage:items-start">
        <span className="text-[10px] text-gray-500 font-mono pt-1.5 @min-[32rem]/audio-stage:w-8 @min-[32rem]/audio-stage:shrink-0">{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className="text-xs uppercase tracking-wider text-port-accent font-medium [overflow-wrap:anywhere]">
              {line.characterName || '(unattributed)'}
            </span>
            {line.characterId ? null : (
              <span
                className="text-[10px] text-gray-500 italic"
                title="No matching character in the series bible — will use project default voice"
              >
                unbound
              </span>
            )}
          </div>
          <textarea
            aria-label={`Dialogue line ${index + 1} text`}
            value={textValue}
            onChange={(e) => setDraft('text', e.target.value)}
            onBlur={() => void saveDraft('text')}
            rows={2}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
            maxLength={4000}
          />
          <div className="mt-2 max-w-md">
            <VoicePicker
              compact
              hideWhenEmpty
              value={line.voiceIdOverride || null}
              onChange={(v) => void saveLinePatch({ voiceIdOverride: v })}
              placeholder={line.characterId
                ? `Inherit (${line.characterName} default)`
                : 'Inherit (project default)'}
              previewText={textValue?.trim() ? textValue.slice(0, 200) : undefined}
            />
          </div>
          {line.audioFilename ? (
            <div className="mt-2">
              <SpokenCheckChip
                verification={line.verification}
                busy={rendering}
                onRerender={handleRender}
                onAccept={handleAcceptSpoken}
              />
            </div>
          ) : null}
          {line.audioFilename ? (
            <audio
              controls
              src={`/data/audio/${encodeURIComponent(line.audioFilename)}`}
              className="mt-2 w-full max-w-md"
            >
              <track kind="captions" />
            </audio>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 w-full @min-[32rem]/audio-stage:w-28 @min-[32rem]/audio-stage:shrink-0">
          <button
            type="button"
            onClick={handleRender}
            disabled={rendering || !textValue.trim()}
            title={textValue.trim() ? 'Render this line as audio' : 'Add line text first'}
            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
          >
            {rendering ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {line.audioFilename ? 'Re-render' : 'Render'}
          </button>
          {/* Per-line start offset (seconds into the episode). Drives
              VO muxing in the final cut; blank = not placed yet. */}
          <label htmlFor={`vo-offset-${index}`} className="text-[10px] text-gray-500 mt-0.5">Start (s)</label>
          <input
            id={`vo-offset-${index}`}
            type="number"
            min="0"
            step="0.1"
            inputMode="decimal"
            value={offsetValue}
            onChange={(e) => setDraft('offsetSec', e.target.value)}
            onBlur={() => void saveDraft('offsetSec')}
            placeholder="—"
            title="When this line plays in the stitched episode (seconds). Blank = not placed."
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </div>
      </div>
    </li>
  );
}
