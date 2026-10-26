import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import GreyboxViewer from './GreyboxViewer';

// This entry has no app shell, API client, media loader or instance state.
globalThis.captureGreybox = (scene, shot) => new Promise((resolve, reject) => {
  const viewer = createRef();
  const root = createRoot(document.getElementById('root'), {
    onUncaughtError: () => reject(new Error('Greybox viewer could not render')),
  });
  root.render(<GreyboxViewer scene={scene} shotView={shot} activeShot={shot} aspect={shot.aspect} focalLengthMm={shot.focalLengthMm}
    ref={viewer} onReady={() => {
      // Let geometry effects and the initial demand frame settle before reading.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try { resolve(viewer.current.capture()); } catch (error) { reject(error); }
      }));
    }} />);
});
