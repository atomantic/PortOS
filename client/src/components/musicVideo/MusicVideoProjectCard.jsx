import { useState, useEffect } from 'react';
import { Film, Play, Music, Wand2, Sparkles, Copy, Trash2, ArrowUpRight } from 'lucide-react';
import MediaImage from '../MediaImage.jsx';
import ScenePreview from '../creative-director/ScenePreview.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { selectMusicVideoPreview } from '../../lib/musicVideoPreview.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import { deriveStages, projectSpend, MUSIC_VIDEO_STAGES } from '../../lib/musicVideoStages.js';

export const STATUS_COLORS = {
  draft: 'bg-port-border text-port-text',
  analyzed: 'bg-port-accent/30 text-port-accent',
  ready: 'bg-port-accent/30 text-port-accent',
  rendering: 'bg-port-warning/30 text-port-warning',
  complete: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

export default function MusicVideoProjectCard({
  project,
  trackLabel,
  onSelect,
  onClone,
  isConfirmingDelete = false,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  cloning = false,
}) {
  const [playing, setPlaying] = useState(false);
  const preview = selectMusicVideoPreview(project);

  // When preview target changes, stop playing
  useEffect(() => {
    setPlaying(false);
  }, [preview.jobId, preview.src]);

  // Video resolution via hook (lazy: only when playing)
  const { src: resolvedSrc, resolving, retry: retryResolve } = useVideoFileSrc(preview.jobId, {
    enabled: playing && preview.kind === 'video',
  });

  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const scenesWithClips = scenes.filter((s) => s.videoHistoryId).length;
  const scenesWithFrames = scenes.filter((s) => s.referenceImageId).length;
  const scenesProgressPct = scenes.length > 0 ? Math.round((scenesWithClips / scenes.length) * 100) : 0;

  const { current: currentStageId } = deriveStages(project);
  const currentStageObj = MUSIC_VIDEO_STAGES.find((s) => s.id === currentStageId);
  const stageLabel = currentStageObj?.label || currentStageId;

  const spend = projectSpend(project);
  const audioTitle = trackLabel || project.uploadedAudioFilename || null;
  const conceptText = project.concept?.style || project.concept?.prompt || null;
  const palette = Array.isArray(project.visualSpec?.palette) ? project.visualSpec.palette : [];

  return (
    <div
      data-testid={`mv-project-card-${project.id}`}
      className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col justify-between hover:border-port-accent/40 transition-colors space-y-3 min-w-0"
    >
      {/* Top Header & Identification */}
      <div className="space-y-1.5 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onSelect}
            className="text-left font-semibold text-base text-port-text hover:text-port-accent transition-colors truncate max-w-full flex-1"
            title={project.name}
          >
            {project.name}
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-border text-port-text-muted font-mono">
              v{project.version || 1}
            </span>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${STATUS_COLORS[project.status] || 'bg-port-border'}`}>
              {project.status}
            </span>
          </div>
        </div>

        {/* Mode & Stage indicators */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          {project.mode === 'autonomous' ? (
            <span className="px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent border border-port-accent/30 flex items-center gap-1">
              <Wand2 size={10} aria-hidden="true" /> Autopilot
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-port-border/60 text-port-text-muted flex items-center gap-1">
              <Film size={10} aria-hidden="true" /> Director
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-port-text-muted">
            Stage: <strong className="text-port-text font-medium">{stageLabel}</strong>
          </span>
          {project.concept?.universeId && (
            <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-1">
              <Sparkles size={10} aria-hidden="true" /> {project.concept.universeId}
            </span>
          )}
        </div>
      </div>

      {/* Media Preview Box */}
      <div className="relative aspect-video rounded bg-black/50 border border-port-border overflow-hidden group shrink-0">
        {preview.kind === 'video' && playing ? (
          resolving ? (
            <div className="w-full h-full flex items-center justify-center text-xs text-port-text-muted">
              Loading video…
            </div>
          ) : (
            <ScenePreview
              jobId={preview.jobId}
              src={resolvedSrc || preview.src}
              onRetry={retryResolve}
              label={`${project.name} — ${preview.label}`}
              aspectClass="aspect-video"
              autoPlay
            />
          )
        ) : preview.kind === 'video' ? (
          <>
            <button
              type="button"
              onClick={onSelect}
              className="block w-full h-full text-left"
              aria-label={`Open project ${project.name}`}
            >
              <MediaImage
                src={preview.poster}
                alt={`${project.name} preview`}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label={`Play ${preview.label}`}
              title={`Play ${preview.label}`}
              className="always-dark absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 hover:scale-105 transition-all shadow-lg focus:outline-none focus:ring-2 focus:ring-port-accent"
            >
              <Play size={16} className="ml-0.5" aria-hidden="true" />
            </button>
            <span className="always-dark absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium pointer-events-none flex items-center gap-1">
              <Film size={10} aria-hidden="true" /> {preview.label}
            </span>
          </>
        ) : preview.kind === 'image' ? (
          <>
            <button
              type="button"
              onClick={onSelect}
              className="block w-full h-full text-left"
              aria-label={`Open project ${project.name}`}
            >
              <MediaImage
                src={preview.src}
                fallbackSrc={preview.fallbackSrc}
                alt={`${project.name} frame`}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
            <span className="always-dark absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium pointer-events-none">
              {preview.label}
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-port-text-muted text-xs hover:bg-port-border/20 transition-colors"
            aria-label={`Open project ${project.name}`}
          >
            <Film size={22} className="opacity-40" aria-hidden="true" />
            <span>No render preview yet</span>
          </button>
        )}
      </div>

      {/* Rich Configuration Options & Audio Info */}
      <div className="space-y-2 text-xs">
        {/* Audio row */}
        <div className="flex items-center justify-between gap-2 text-port-text-muted">
          <span className="flex items-center gap-1.5 truncate font-medium text-port-text" title={audioTitle || 'No audio track'}>
            <Music size={13} className="text-port-accent shrink-0" aria-hidden="true" />
            <span className="truncate">{audioTitle || 'No audio track'}</span>
          </span>
          {project.audioAnalysis?.bpm ? (
            <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-port-bg border border-port-border">
              {project.audioAnalysis.bpm} BPM
            </span>
          ) : null}
        </div>

        {/* Configuration Badges */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border font-mono text-[10px]" title="Video Backend">
            {project.videoSettings?.backend || 'local'}
          </span>
          {project.videoSettings?.modelId && (
            <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border font-mono text-[10px] truncate max-w-[120px]" title={`Model: ${project.videoSettings.modelId}`}>
              {project.videoSettings.modelId}
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px]">
            {project.videoSettings?.generationMode === 'text' ? 'T2V' : 'I2V'}
          </span>
          {project.videoSettings?.audioReactiveLora && (
            <span className="px-1.5 py-0.5 rounded bg-port-accent/15 text-port-accent text-[10px] border border-port-accent/30" title="Audio Reactive LoRA">
              Reactive
            </span>
          )}
          {project.vocalStemFilename && (
            <span className="px-1.5 py-0.5 rounded bg-port-accent/15 text-port-accent text-[10px] border border-port-accent/30">
              Vocal Stem
            </span>
          )}
          {project.midiTranscription && (
            <span className="px-1.5 py-0.5 rounded bg-port-accent/15 text-port-accent text-[10px] border border-port-accent/30">
              MIDI
            </span>
          )}
          {project.composition?.mode && project.composition.mode !== 'concat' && (
            <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px] capitalize">
              {project.composition.mode}
            </span>
          )}
          {palette.length > 0 && (
            <div className="flex items-center gap-0.5 ml-1" title="Color palette">
              {palette.slice(0, 5).map((color, idx) => (
                <span
                  key={idx}
                  className="w-2.5 h-2.5 rounded-full border border-port-border shrink-0"
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>
          )}
        </div>

        {/* Concept / Style snippet */}
        {conceptText && (
          <p className="text-[11px] text-port-text-muted italic line-clamp-1 truncate" title={conceptText}>
            &ldquo;{conceptText}&rdquo;
          </p>
        )}

        {/* Storyboard & scenes progress */}
        <div className="space-y-1 pt-1.5 border-t border-port-border/40 text-[11px]">
          <div className="flex items-center justify-between text-port-text-muted">
            <span>
              {scenes.length} scene{scenes.length === 1 ? '' : 's'}
              {scenesWithClips > 0 ? ` · ${scenesWithClips} clip${scenesWithClips === 1 ? '' : 's'}` : ''}
              {scenesWithFrames > 0 && scenesWithClips === 0 ? ` · ${scenesWithFrames} frame${scenesWithFrames === 1 ? '' : 's'}` : ''}
            </span>
            {spend.capUsd != null || spend.spentUsd > 0 ? (
              <span className="font-mono text-port-text-muted">
                ${spend.spentUsd.toFixed(2)}{spend.capUsd != null ? ` / $${spend.capUsd}` : ''}
              </span>
            ) : null}
          </div>
          {scenes.length > 0 && (
            <div className="h-1 bg-port-bg rounded overflow-hidden">
              <div
                className="h-full bg-port-accent transition-all duration-300"
                style={{ width: `${scenesProgressPct}%` }}
                title={`${scenesProgressPct}% clips rendered`}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer Actions */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-port-border mt-auto shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSelect}
            className="bg-port-accent hover:bg-port-accent/80 text-white rounded px-2.5 py-1 text-xs font-medium flex items-center gap-1 min-h-[32px] transition-colors"
          >
            Open <ArrowUpRight size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onClone?.()}
            disabled={cloning}
            title="Fork this project version"
            className="bg-port-bg border border-port-border hover:bg-port-border/40 text-port-text rounded px-2 py-1 text-xs flex items-center gap-1 min-h-[32px] disabled:opacity-50 transition-colors"
          >
            <Copy size={13} aria-hidden="true" /> {cloning ? 'Forking…' : 'Fork'}
          </button>
        </div>

        {isConfirmingDelete ? (
          <ConfirmButtonPair
            prompt="Delete?"
            confirmText="Delete"
            ariaLabel={`Confirm delete project ${project.name}`}
            confirmAriaLabel={`Confirm delete project ${project.name}`}
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          />
        ) : (
          <button
            type="button"
            onClick={onRequestDelete}
            title={`Delete project ${project.name}`}
            aria-label={`Delete project ${project.name}`}
            className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded border border-port-border px-2 py-1 text-xs text-port-error hover:bg-port-error/10 transition-colors"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
