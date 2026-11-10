import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import useGeneratedPreview from '../../hooks/useGeneratedPreview.js';
import { normalizeTitleCard } from '../../../../server/lib/musicVideoTitleCard.js';
import { documentPreviewLook, documentPreviewRevision } from './CompositionPreviewPlayer.jsx';

/**
 * The composition document's exact frame at song time `time`, laid over the
 * native player's picture while `active` (the song is paused on a frame the
 * viewer chose). The isolated preview worker draws it; its session opens the
 * first time `active` is true, so a viewer who only plays never starts one.
 * Shows nothing until the frame for `time` has arrived, and nothing when the
 * host has no isolated worker: the native picture stays underneath.
 * The ref's `capture(t)` resolves the shown frame's JPEG, or null when the
 * frame on screen is not the one for `t`.
 */
const ExactDocumentFrame = forwardRef(function ExactDocumentFrame({ project, time, active, lookOn }, ref) {
  const [engaged, setEngaged] = useState(false);
  useEffect(() => { if (active) setEngaged(true); }, [active]);
  const revision = documentPreviewRevision(project);
  const request = useMemo(() => (engaged && revision
    ? { kind: 'music-video', projectId: project.id, draft: false, lyrics: false, revision } : null), [engaged, revision, project.id]);
  const look = documentPreviewLook(project, lookOn);
  const lookKey = JSON.stringify(look);
  const card = useMemo(() => normalizeTitleCard(project.titleCard), [project.titleCard]);
  // `look` is a new object each render; its serialization is its identity.
  const controls = useMemo(() => ({ look, card }), [lookKey, card]);
  const preview = useGeneratedPreview({ active: !!request, request, controls });
  const { ready, status, seek, resume, frameUrl, frameTime, captureFrame } = preview;
  // The frame on screen when the current time was asked for: a session that
  // reports no frame times (exact-seek fallback) is fresh once that picture changes.
  const [asked, setAsked] = useState(null);
  // The server retires an idle session; the next paused frame reopens it.
  // A hook that has not opened yet also reads idle, so only a lapsed one resumes.
  const lapsed = useRef(false);
  useEffect(() => {
    if (!active) { setAsked(null); return; }
    if (ready) lapsed.current = true;
    else if (status === 'idle' && lapsed.current) { lapsed.current = false; resume(); }
    if (!ready) return;
    setAsked({ t: time, url: frameUrl });
    seek(time);
    // frameUrl is read as "the picture before this seek", not as a trigger.
  }, [active, ready, status, time, seek, resume, lookKey, card]);
  const fresh = active && !!frameUrl && asked?.t === time
    && (frameTime != null ? Math.abs(frameTime - time) < 1e-6 : frameUrl !== asked.url);
  const shown = useRef(null);
  shown.current = fresh ? time : null;
  useImperativeHandle(ref, () => ({
    shownTime: () => shown.current,
    capture: (t) => (shown.current === t ? captureFrame() : Promise.resolve(null)),
  }), [captureFrame]);
  if (!frameUrl) return null;
  return (
    <img ref={preview.imageRef} onLoad={preview.onFrameLoad} src={frameUrl} alt="" data-testid="exact-document-frame" data-shown={fresh ? 'true' : 'false'}
      className="pointer-events-none absolute inset-0 h-full w-full bg-black object-contain" style={{ opacity: fresh ? 1 : 0 }} />
  );
});

export default ExactDocumentFrame;
