import { useState } from 'react';
import { isWebGLAvailable } from '../../lib/webglSupport';
import { glbErrorText, glbFailureHint } from '../../lib/glbFailure';
import ErrorBoundary from '../ErrorBoundary';
import CoSAvatarFrame from './CoSAvatarFrame';

/**
 * Gate CoS 3D avatar canvases on WebGL availability and catch render-time
 * failures so a missing GPU never leaves an unhandled promise rejection or a
 * blank panel. Callers pass the r3f `<Canvas>…</Canvas>` as children.
 *
 * The two causes are reported SEPARATELY. Every caught error used to show the
 * WebGL hint, but these avatars load remote GLBs (`MuseCoSAvatar` →
 * `/api/avatar/model.glb`, `MiniCharacterCoSAvatar` → `useClonedGltf(url)`), so
 * a model 404 told the user to go change an unrelated setting. `isWebGLAvailable`
 * is a real pre-gate and keeps the WebGL hint; anything thrown afterwards is an
 * asset failure and says so.
 *
 * Both panels are the guard's own, with no caller override. The GLB-loading
 * callers used to pass their "no model — run setup" hint as a `fallback`, but
 * they reach this guard ONLY after a HEAD request proved the model is there, so
 * that hint was wrong on both branches: it hid the asset-failure message for a
 * server answering with HTML, and it told a user with no WebGL to go run
 * `npm run setup:data`. Misdirecting the user is the bug #4688 is about.
 */

const panelClass = (background) =>
  `${background ? 'relative w-full h-full min-h-full' : 'relative w-full aspect-[5/6]'} flex flex-col items-center justify-center rounded-lg border border-port-border bg-port-card/60 text-center p-3`;

function WebGLUnavailableHint({ background = false }) {
  return (
    <div className={panelClass(background)}>
      <div className="text-2xl mb-2" aria-hidden="true">🖥️</div>
      <div className="text-xs font-semibold text-gray-200 mb-1">3D unavailable</div>
      <div className="text-[10px] text-gray-400 leading-snug">
        This display has no WebGL. Pick the SVG or ASCII avatar in CoS Config.
      </div>
    </div>
  );
}

// Named for the failure, not the cause: four of the six avatars are procedural
// scenes with no GLB at all, so a throw from one of those is a render failure
// rather than a load failure. `glbFailureHint` names a cause only when it
// recognizes one, and the raw message covers the rest.
function AvatarRenderFailure({ background = false, error }) {
  // `null` from the shared hint table means "we don't recognize this" — fall
  // back to the raw message rather than inventing a cause.
  const hint = glbFailureHint(error);
  return (
    <div className={panelClass(background)} data-testid="cos-avatar-asset-error" role="alert">
      <div className="text-2xl mb-2" aria-hidden="true">⚠️</div>
      <div className="text-xs font-semibold text-gray-200 mb-1">Avatar could not be displayed</div>
      <div className="text-[10px] text-gray-400 leading-snug">
        {hint || glbErrorText(error) || 'The 3D avatar could not be rendered.'}
      </div>
    </div>
  );
}

export default function CoSCanvasGuard({
  label = 'Interactive 3D avatar. Drag to rotate.',
  background = false,
  resetKey = null,
  children,
}) {
  // Probe once on mount — availability doesn't flip mid-session.
  const [supported] = useState(() => isWebGLAvailable());
  // The r3f `<Canvas>` re-throws from its own render, and the message belongs in
  // the DOM chrome around it — so the shared boundary degrades the scene with
  // `fallback={null}` and hands the error up here via `onError`.
  //
  // The failure is stored WITH the `resetKey` it belongs to. Without that it
  // would stick forever: once the panel is up the boundary is unmounted, so
  // nothing can ever re-try. A caller whose avatar can change model — the
  // mini-character wrappers switch `variant`, and with it the GLB URL — passes
  // that URL as `resetKey` so one variant's dead model can't blank the next.
  const [failure, setFailure] = useState(null);
  const error = failure?.key === resetKey ? failure.error : null;

  if (!supported) return <WebGLUnavailableHint background={background} />;
  if (error) return <AvatarRenderFailure background={background} error={error} />;

  return (
    <CoSAvatarFrame label={label} background={background}>
      <ErrorBoundary fallback={null} onError={(caught) => setFailure({ key: resetKey, error: caught })}>
        {children}
      </ErrorBoundary>
    </CoSAvatarFrame>
  );
}

export { WebGLUnavailableHint };
