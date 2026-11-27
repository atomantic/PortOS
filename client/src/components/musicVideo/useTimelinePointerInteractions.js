import { useEffect, useRef, useState } from 'react';
import { snapCutTime } from '../../lib/musicVideoTimeline.js';

// A dragged cut is pulled onto a beat, section edge or lyric line within this many pixels.
const CUT_SNAP_PX = 6;
// A mouse press on a clip becomes a reorder drag after moving this far.
const REORDER_DRAG_PX = 6;

export default function useTimelinePointerInteractions({
  scrollerRef, live, timeRef, onSeek, cutDrag, setCutDrag, onMoveCut, snapPoints,
  savedShots, onReorder,
}) {
  // Tap or drag the ruler to move the player; a drag seeks at most once a frame.
  const scrub = useRef(null);
  const seekAt = (clientX) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const x = clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    const t = Math.min(Math.max(0, x / live.current.pxPerSec), live.current.durationSec);
    timeRef.current = t;
    onSeek?.(Math.round(t * 1000) / 1000);
  };
  const onRulerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrub.current = { pointerId: event.pointerId, pending: null, frame: null };
    seekAt(event.clientX);
  };
  const onRulerMove = (event) => {
    const drag = scrub.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.pending = event.clientX;
    if (drag.frame != null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      if (scrub.current === drag && drag.pending != null) seekAt(drag.pending);
    });
  };
  const onRulerUp = (event) => {
    const drag = scrub.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame != null) cancelAnimationFrame(drag.frame);
    scrub.current = null;
  };
  useEffect(() => () => { if (scrub.current?.frame != null) cancelAnimationFrame(scrub.current.frame); }, []);

  // Drag a cut: the pointer is captured by its handle, and the save starts when it is let go.
  const cutPointer = useRef(null);
  const commitCut = (cut, t) => {
    if (Math.abs(t - cut.t) < 1e-4) { setCutDrag(null); return; }
    setCutDrag({ id: cut.id, t, snapped: false, saving: true });
    onSeek?.(t);
    Promise.resolve(onMoveCut(cut.sceneId, cut.edge, t)).catch(() => {}).finally(() => {
      setCutDrag((current) => (current?.id === cut.id && current.saving ? null : current));
    });
  };
  const onCutDown = (event, cut) => {
    if ((event.button != null && event.button !== 0) || cutDrag?.saving) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    cutPointer.current = { pointerId: event.pointerId, startX: event.clientX, cut };
    setCutDrag({ id: cut.id, t: cut.t, snapped: false });
  };
  const onCutMove = (event) => {
    const drag = cutPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { pxPerSec: px } = live.current;
    const next = snapCutTime(drag.cut.t + (event.clientX - drag.startX) / px, drag.cut, snapPoints, CUT_SNAP_PX / px);
    setCutDrag({ id: drag.cut.id, ...next });
  };
  const onCutUp = (event, cancelled = false) => {
    const drag = cutPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cutPointer.current = null;
    if (cancelled || !cutDrag || cutDrag.id !== drag.cut.id) { setCutDrag(null); return; }
    commitCut(drag.cut, cutDrag.t);
  };
  const nudgeCut = (event, cut) => {
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || cutDrag?.saving) return;
    event.preventDefault();
    commitCut(cut, snapCutTime(cut.t + dir * (event.shiftKey ? 1 : 1 / 24), cut).t);
  };

  // Drag a clip onto another with a mouse to move it there; a press that never moves is a tap.
  const [reorder, setReorder] = useState(null);
  const reorderPointer = useRef(null);
  const suppressClick = useRef(false);
  const indexAt = (clientX) => {
    const scroller = scrollerRef.current;
    const t = (clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft) / live.current.pxPerSec;
    const at = savedShots.findIndex((shot) => t < shot.endSec);
    return at < 0 ? savedShots.length - 1 : at;
  };
  const onClipDown = (event, index) => {
    if (!onReorder || event.pointerType !== 'mouse' || event.button !== 0) return;
    reorderPointer.current = { pointerId: event.pointerId, startX: event.clientX, index, dragging: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onClipMove = (event) => {
    const drag = reorderPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging && Math.abs(dx) < REORDER_DRAG_PX) return;
    drag.dragging = true;
    setReorder({ from: drag.index, to: indexAt(event.clientX), dx });
  };
  const onClipUp = (event, cancelled = false) => {
    const drag = reorderPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    reorderPointer.current = null;
    setReorder(null);
    if (!drag.dragging) return;
    // The click that follows a drag's release is not a tap on the clip.
    suppressClick.current = true;
    requestAnimationFrame(() => { suppressClick.current = false; });
    const to = indexAt(event.clientX);
    if (!cancelled && to !== drag.index) onReorder(drag.index, to);
  };
  return { onRulerDown, onRulerMove, onRulerUp, onCutDown, onCutMove, onCutUp, nudgeCut, reorder,
    suppressClick, onClipDown, onClipMove, onClipUp };
}
