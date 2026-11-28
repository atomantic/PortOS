import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// Within this many pixels of the end counts as "reading the latest words", so
// streaming text keeps the newest line in view until the reader scrolls back.
const FOLLOW_SLACK_PX = 8;

/**
 * Live subtitle over the handset viewfinder. Two lines while collapsed, always
 * showing the newest words as a reply streams; a long reply can be scrolled in
 * place or expanded over the portrait with a tap so none of it is cut off.
 */
export default function SatPhoneCaption({ caption }) {
  const boxRef = useRef(null);
  const followRef = useRef(true);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const text = caption || 'Ready when you are.';

  // A new utterance (not a continuation of the streaming one) starts
  // collapsed and following its newest words.
  const prevTextRef = useRef(text);
  useLayoutEffect(() => {
    const prev = prevTextRef.current;
    prevTextRef.current = text;
    if (text.startsWith(prev)) return;
    followRef.current = true;
    setExpanded(false);
  }, [text]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (followRef.current) box.scrollTop = box.scrollHeight;
    setOverflowing(box.scrollHeight > box.clientHeight + 1);
  }, [text, expanded]);

  const onScroll = () => {
    const box = boxRef.current;
    if (box) followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK_PX;
  };
  const canToggle = overflowing || expanded;
  // Collapsing jumps back to the newest words; expanding keeps the place.
  const toggle = () => {
    followRef.current = expanded;
    setExpanded((value) => !value);
  };

  return (
    <div className="absolute inset-x-2 bottom-2 top-9 flex flex-col justify-end pointer-events-none">
      <div className="port-media-overlay pointer-events-auto relative flex min-h-9 max-h-full flex-col rounded-md border border-port-border/60 border-l-2 border-l-port-accent">
        <div
          ref={boxRef}
          onScroll={onScroll}
          data-expanded={expanded ? 'true' : 'false'}
          className={`min-h-0 overflow-y-auto overscroll-contain break-words py-1.5 pl-2.5 font-mono text-[11px] leading-snug ${
            canToggle ? 'pr-8 pointer-coarse:pr-11' : 'pr-2.5'
          } ${expanded ? '' : 'max-h-11'}`}
        >
          <span aria-hidden="true" className="whitespace-pre-wrap">{text}</span>
        </div>
        {canToggle && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse the caption' : 'Show the whole caption'}
            title={expanded ? 'Collapse' : 'Show all'}
            className="absolute right-0.5 top-0.5 inline-flex h-7 w-7 items-center justify-center rounded text-port-text-muted hover:text-port-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-port-accent pointer-coarse:h-11 pointer-coarse:w-11"
          >
            {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}
