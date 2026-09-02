import { useCallback, useRef, useState } from 'react';

// Shared "preview a weight download, then confirm" state machine. Two near-
// identical copies (LocalLlmTab's model/spec-decode/MTPLX downloads, Loras'
// Civitai/HuggingFace installs) collapsed to one hook: request() shows a
// loading modal, resolves the disk-preflight assessment, and holds the
// caller's `run` callback until confirmRun() fires it.
//
// Usage:
//   const { confirm, request, cancel, confirmRun } = useDownloadPreflightConfirm();
//   const install = (modelId) => request({
//     title: 'Install local model',
//     preview: () => previewLocalLlmDownload({ kind: 'install', backend, modelId }, { silent: true }),
//     run: () => startInstall(modelId),
//   });
//   <DownloadPreflightConfirm open={Boolean(confirm)} {...confirm} onCancel={cancel} onConfirm={confirmRun} />
export default function useDownloadPreflightConfirm() {
  const [confirm, setConfirm] = useState(null);
  // Bumped on every request() and every cancel() so a preview that resolves
  // after the user already cancelled — or after a newer request superseded
  // it — can tell it's stale and skip reopening/overwriting the modal.
  const requestId = useRef(0);

  const request = useCallback(({ title, preview, run }) => {
    const id = ++requestId.current;
    setConfirm({ title, loading: true, error: null, assessment: null, run: null });
    return preview()
      .then((assessment) => {
        if (requestId.current !== id) return;
        setConfirm({ title, loading: false, error: null, assessment, run });
      })
      .catch((err) => {
        if (requestId.current !== id) return;
        // A caller can mark a preview rejection `handled` (e.g. it already
        // routed a CIVITAI_AUTH failure into its own key-entry prompt) —
        // close this modal silently instead of layering a second, generic
        // error dialog on top of the one the caller just opened.
        if (err?.handled) {
          setConfirm(null);
          return;
        }
        setConfirm({
          title,
          loading: false,
          error: err?.message || 'Could not check disk space',
          assessment: null,
          run: null,
        });
      });
  }, []);

  const cancel = useCallback(() => {
    requestId.current += 1;
    setConfirm(null);
  }, []);
  // Read `run` before clearing state and invoke it outside the setState
  // updater — React StrictMode double-invokes an updater function in dev to
  // surface impure ones, so a `setConfirm(prev => { prev.run(); ... })` shape
  // would start the download twice.
  const confirmRun = useCallback(() => {
    const run = confirm?.run;
    setConfirm(null);
    run?.();
  }, [confirm]);

  return { confirm, request, cancel, confirmRun };
}
