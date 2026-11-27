import { publishExportLabel } from '../../../../server/lib/musicVideo/musicVideoPublishExports.js';
import { useEffect, useRef, useState } from 'react';
import { Package, Download, Copy, Captions, ListOrdered } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard.js';
import PublishCard from './PublishCard.jsx';
import PublishCropPreview from './PublishCropPreview.jsx';
import PublishVerticalPreview from './PublishVerticalPreview.jsx';
import VideoUpscaleDrawer from '../media/VideoUpscaleDrawer.jsx';
import MediaJobsQueue from '../media/MediaJobsQueue.jsx';
import { formatLoudness } from '../../utils/formatters.js';

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const chaptersText = (chapters) => chapters.map((c) => `${fmtTime(c.startSec)} ${c.label}`).join('\n');

function KitDownloads({ kit }) {
  return (
    <div className="space-y-2 text-xs">
      <ul className="space-y-1">
        {kit.master?.filename && (
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>YouTube master (the final render)</span>
            <a href={`/data/videos/${kit.master.filename}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0"><Download size={12} /> Download</a>
          </li>
        )}
        {(kit.exports || []).map((e) => {
          const loudness = formatLoudness(e.loudness);
          return (
            <li key={e.filename} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span>{publishExportLabel(e)}{e.kind === 'teaser' && e.startSec != null && <span className="text-port-text-muted"> · {fmtTime(e.startSec)}–{fmtTime(e.endSec)}</span>}</span>
                {loudness && <p className="text-port-text-muted">{loudness}</p>}
              </div>
              <a href={`/data/videos/${e.filename}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0"><Download size={12} /> Download</a>
            </li>
          );
        })}
        {kit.captionsFilename && (
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1"><Captions size={12} /> Lyric captions (SRT)</span>
            <a href={`/data/videos/${kit.captionsFilename}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0"><Download size={12} /> Download</a>
          </li>
        )}
      </ul>
      {kit.chapters?.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-port-text-muted flex items-center gap-1"><ListOrdered size={12} /> YouTube chapters (paste into the description)</span>
            <button type="button" onClick={() => copyToClipboard(chaptersText(kit.chapters), 'Chapters copied')} aria-label="Copy chapters"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted min-h-[44px] sm:min-h-0 px-1"><Copy size={12} /></button>
          </div>
          <pre className="bg-port-bg border border-port-border rounded p-2 whitespace-pre-wrap break-words font-mono text-[11px]">{chaptersText(kit.chapters)}</pre>
        </div>
      )}
    </div>
  );
}

export default function PublishAssetsCard({ project, publishKit }) {
  const kit = project?.publishKit || {};
  const idFor = (s) => `mv-publish-${project?.id}-${s}`;
  const [loudnessPreset, setLoudnessPreset] = useState('as-mixed');
  const [upscaleSource, setUpscaleSource] = useState(null);
  const [upscaledVideo, setUpscaledVideo] = useState(null);
  const currentRender = useRef(null);
  currentRender.current = `${project?.id}:${project?.renderHistoryId}`;
  useEffect(() => { setUpscaleSource(null); setUpscaledVideo(null); }, [project?.id, project?.renderHistoryId]);
  const canBuild = !!project?.renderHistoryId;
  const crop = publishKit.crop;
  const kitStale = !!kit.builtAt && (kit.master?.renderHistoryId ?? null) !== (project?.renderHistoryId ?? null);
  return (
    <>
      <PublishCard projectId={project?.id} cardId="assets" label="Release assets" icon={Package}
        summary={kit.builtAt ? `Built ${new Date(kit.builtAt).toLocaleDateString()}` : 'Not built yet'} defaultOpen={!kit.builtAt}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {canBuild && (
              <div className="flex items-center gap-1.5">
                <label htmlFor={idFor('loudness')} className="text-port-text-muted">Copy loudness</label>
                <select id={idFor('loudness')} value={loudnessPreset} disabled={publishKit.building} onChange={e => setLoudnessPreset(e.target.value)}
                  className="rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50">
                  <option value="as-mixed">As mixed</option>
                  <option value="web">Web (−14 LUFS)</option>
                </select>
              </div>
            )}
            <button type="button" disabled={!canBuild || publishKit.building || !!publishKit.cropBlockedReason} onClick={() => publishKit.build({ loudnessPreset })}
              className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0">
              <Package size={13} /> {kit.builtAt ? 'Rebuild kit' : 'Build publishing kit'}
            </button>
          </div>
        )}>
        {!canBuild && <p className="text-xs text-port-text-muted">Render the final video first. The kit is made from it.</p>}
        {(publishKit.canCrop || crop || publishKit.verticalMode === 'framed') && (
          <div className="space-y-2">
            <label className="flex flex-wrap items-center gap-2 text-xs">
              Vertical 9:16 layout
              <select value={publishKit.verticalMode || (crop ? 'crop' : 'auto')} disabled={publishKit.building}
                onChange={event => (publishKit.setVerticalMode ? publishKit.setVerticalMode(event.target.value) : publishKit.setCropMode(event.target.value === 'crop'))}
                className="rounded border border-port-border bg-port-bg px-2 py-1.5 min-h-11 pointer-fine:sm:min-h-0">
                <option value="auto">Automatic (native or fit)</option>
                <option value="framed">Framed 16:9 (TikTok header + footer)</option>
                <option value="crop">Crop from master</option>
              </select>
            </label>
            {publishKit.verticalMode === 'framed' && publishKit.verticalFrame && (
              <PublishVerticalPreview
                project={project}
                span={publishKit.verticalSpan || 'full'}
                frame={publishKit.verticalFrame}
                onSpanChange={publishKit.setVerticalSpan}
                onFrameChange={publishKit.updateVerticalFrame}
                disabled={publishKit.building}
              />
            )}
            {crop && publishKit.cropBlockedReason && <p role="status" className="text-xs text-port-text-muted">{publishKit.cropBlockedReason}</p>}
            {crop && !crop.pending && (crop.error || crop.preview?.renderHistoryId !== project.renderHistoryId) && (
              <button type="button" onClick={publishKit.refreshCropPreview}
                className="rounded border border-port-border px-2 py-1.5 text-xs hover:text-port-accent min-h-11 pointer-fine:sm:min-h-0">
                Refresh crop preview
              </button>
            )}
            {crop?.preview && !crop.error && crop.preview.renderHistoryId === project.renderHistoryId && (
              <PublishCropPreview key={`${crop.preview.renderHistoryId}:${crop.preview.startSec}:${crop.preview.endSec}`}
                preview={crop.preview} position={crop.position}
                span={publishKit.verticalSpan || 'hook'} onSpanChange={publishKit.setVerticalSpan}
                onPosition={publishKit.setCropPosition} onMediaState={publishKit.setCropMediaState} />
            )}
          </div>
        )}
        {canBuild && (
          <div className="space-y-2">
            <button type="button" onClick={() => { setUpscaledVideo(null); setUpscaleSource({ id: project.renderHistoryId, key: currentRender.current }); }}
              className="rounded border border-port-border px-2 py-1.5 text-xs hover:text-port-accent min-h-[44px] pointer-fine:sm:min-h-0">
              Upscale final render
            </button>
            <p className="text-xs text-port-text-muted">Creates a separate video in the gallery; the final master stays unchanged.</p>
            {upscaledVideo?.filename && (
              <a href={`/data/videos/${encodeURIComponent(upscaledVideo.filename)}`} download className="text-xs text-port-accent">Download upscaled video</a>
            )}
          </div>
        )}
        {kitStale && (
          <p role="status" className="text-xs text-port-warning">Kit built from an earlier render. Fill draft is refused until you rebuild it. Use Rebuild kit.</p>
        )}
        {publishKit.building && (
          <div className="space-y-2">
            <div className="h-1.5 bg-port-bg rounded overflow-hidden"><div className="h-full bg-port-accent transition-all" style={{ width: `${publishKit.progress}%` }} /></div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-port-text-muted">Encoding — {Math.round(publishKit.progress)}%</p>
              <button type="button" onClick={publishKit.cancelBuild} aria-label="Cancel build" className="min-h-11 min-w-11 pointer-fine:sm:min-h-0 pointer-fine:sm:min-w-0 text-xs text-port-text-muted hover:text-port-text-base px-2 py-1">Cancel</button>
            </div>
          </div>
        )}
        {kit.builtAt && <KitDownloads kit={kit} />}
      </PublishCard>

      <VideoUpscaleDrawer item={upscaleSource} onClose={() => setUpscaleSource(null)} onUpscaled={(video) => {
        if (upscaleSource?.key === currentRender.current) setUpscaledVideo(video);
      }} />
      <MediaJobsQueue kind="video-upscale" />
    </>
  );
}
