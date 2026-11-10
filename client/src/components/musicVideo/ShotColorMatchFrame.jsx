import { useId } from 'react';
import { activeShotColorMatch, colorMatchSvgParts } from '../../../../server/lib/shotColorMatch.js';

/**
 * The shot's color match under the film look. Matching off returns the picture
 * unchanged, so an animatic with no correction keeps today's markup. The filter
 * is the same curve the render's geq applies.
 */
export default function ShotColorMatchFrame({ project, scene, className = 'h-full w-full', children }) {
  const correction = activeShotColorMatch(project, scene);
  const rawId = useId();
  if (!correction) return children;
  const parts = colorMatchSvgParts(correction);
  const filterId = `shot-color-match-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  // The filter definition stays outside the filtered box. A url() filter whose
  // definition is a descendant of the element it styles does not paint the picture.
  return (
    <>
      <svg width="0" height="0" className="pointer-events-none absolute h-0 w-0 overflow-hidden" aria-hidden="true">
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={parts.balance} />
          <feComponentTransfer>
            <feFuncR type="gamma" amplitude="1" exponent={parts.gamma} offset="0" />
            <feFuncG type="gamma" amplitude="1" exponent={parts.gamma} offset="0" />
            <feFuncB type="gamma" amplitude="1" exponent={parts.gamma} offset="0" />
          </feComponentTransfer>
          <feColorMatrix type="matrix" values={parts.saturate} />
        </filter>
      </svg>
      <div className={className} data-document-color-match={String(scene.sceneId).replace(/[^A-Za-z0-9_-]/g, '')} style={{ filter: `url(#${filterId})` }}>
        {children}
      </div>
    </>
  );
}
