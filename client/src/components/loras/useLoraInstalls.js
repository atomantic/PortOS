import { useState, useCallback } from 'react';
import toast from '../ui/Toast';
import useDownloadPreflightConfirm from '../../hooks/useDownloadPreflightConfirm';
import {
  installLoraFromCivitai,
  previewLoraInstall,
  installLoraFromHuggingfaceStream,
} from '../../services/apiImageVideo.js';
import { hfCardKey, suggestionKey } from './loraDisplay';

// Install state machine for the LoRA Manager: the Civitai form + suggestion
// cards, the HuggingFace form + family-override retry, and curated video
// quick-installs, all gated by the shared download-preflight confirm. `refresh`
// reloads the installed list after a success; `setView` surfaces the Discover
// view when an HF install needs the inline family picker.
export default function useLoraInstalls({ refresh, setView, discoverView }) {
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  // HuggingFace LoRA import (Flux.2 Klein image adapters, fal / Lightricks
  // LTX video LoRAs) — separate from the Civitai installer above.
  const [hfUrl, setHfUrl] = useState('');
  const [hfInstalling, setHfInstalling] = useState(false);
  // Byte-level download progress for the in-flight HF install (form OR curated
  // quick-install — only one runs at a time). `{ received, total, progress }`
  // where progress is 0..1, or null when the server had no Content-Length.
  const [hfProgress, setHfProgress] = useState(null);
  // When autodetection can't classify the repo (HF_UNKNOWN_FAMILY), hold the
  // URL here to render an inline family picker — the API supports an explicit
  // family override, so a valid LoRA with an unrecognizable id shouldn't
  // dead-end at an error toast (or get force-tagged as LTX-Video).
  const [hfFamilyPrompt, setHfFamilyPrompt] = useState(null);
  // Set to a pending install URL when a Civitai 401/403 redirects the user to
  // the inline key form. The form saves the key and retries the same install
  // in one click so users don't have to remember what they were installing.
  const [authPrompt, setAuthPrompt] = useState(null);
  const [installingSuggestion, setInstallingSuggestion] = useState(null);
  // Name of the most recent successful install, cleared once the user acts on
  // it. Drives the Discover view's "View installed" hand-off so a finished
  // download doesn't leave the user hunting the catalog for its result.
  const [lastInstalled, setLastInstalled] = useState(null);
  const { confirm: downloadConfirm, request: requestDownloadConfirm, cancel: cancelDownloadConfirm, confirmRun: runDownloadConfirm } = useDownloadPreflightConfirm();
  // Repo+file key of the video suggestion currently installing. A single HF
  // repo can publish multiple versions that must remain independently selectable.
  const [installingVideoKey, setInstallingVideoKey] = useState(null);

  // silent:true so the auth-error path goes through the modal instead of a
  // one-shot toast the user can't act on. Shared by the initial install
  // submit and the post-key-save retry so both behave identically.
  //
  // A gated Civitai model can already fail with CIVITAI_AUTH at the PREVIEW
  // step (previewCivitaiInstall fetches the model metadata, which needs the
  // same key the download does) — before startCivitaiInstall ever runs. Catch
  // it here and route it into the existing key-entry prompt instead of
  // letting the hook's generic error land inside the preflight modal, which
  // has no path back to that prompt.
  const requestLoraDownload = useCallback((title, url, source, run, extra = {}) => requestDownloadConfirm({
    title,
    preview: () => previewLoraInstall({ url, source, ...extra, silent: true }).catch((err) => {
      if (source === 'civitai' && err?.code === 'CIVITAI_AUTH') {
        setAuthPrompt({ url, message: err.message || 'This LoRA needs an API key.' });
        // No confirm modal opens for a `handled` rejection, so nothing else
        // will clear a suggestion card's spinner for this attempt.
        setInstallingSuggestion(null);
        const handled = new Error(err.message);
        handled.handled = true;
        throw handled;
      }
      throw err;
    }),
    run,
  }), [requestDownloadConfirm]);

  // Dismissing the confirm modal without confirming ends a suggestion card's
  // install attempt before startCivitaiInstall/startVideoSuggestionInstall
  // ever run — clear its spinner here too, or it sticks until another card
  // is clicked. A no-op for every other caller of the shared modal.
  const handleCancelDownloadConfirm = useCallback(() => {
    cancelDownloadConfirm();
    setInstallingSuggestion(null);
  }, [cancelDownloadConfirm]);

  const startCivitaiInstall = useCallback(async (url) => {
    if (!url || installing) return;
    setInstalling(true);
    await installLoraFromCivitai({ url, silent: true })
      .then((sidecar) => {
        toast.success(`Installed ${sidecar.name}`);
        setLastInstalled(sidecar.name);
        setInstallUrl('');
        refresh({ background: true });
      })
      .catch((err) => {
        // Early-access content is gated by Civitai membership, not by API
        // key — routing into the key-prompt modal would be misleading
        // because the user's key (saved or env) can't unlock it. Surface
        // the message (which already includes hours-remaining) as a toast.
        if (err?.code === 'CIVITAI_EARLY_ACCESS') {
          toast.error(err.message || 'LoRA is in Civitai early-access');
        } else if (err?.code === 'CIVITAI_AUTH') {
          setAuthPrompt({ url, message: err.message || 'This LoRA needs an API key.' });
        } else {
          toast.error(err?.message || 'Install failed');
        }
      })
      // Clears whichever suggestion card (if any) triggered this install —
      // a no-op for the manual-form submit, which never sets it.
      .finally(() => { setInstalling(false); setInstallingSuggestion(null); });
  }, [installing, refresh]);

  const performInstall = useCallback((url) => {
    if (!url || installing) return undefined;
    return requestLoraDownload('Install LoRA', url, 'civitai', () => startCivitaiInstall(url));
  }, [installing, requestLoraDownload, startCivitaiInstall]);

  const handleInstall = (e) => {
    e?.preventDefault?.();
    return performInstall(installUrl.trim());
  };

  // Curated cards pass a family-specific (url, versionId); non-curated cards
  // omit versionId and we fall back to the card's primary.
  const installSuggestion = (card, url, versionId) => {
    const vid = versionId ?? card.versionId;
    const key = suggestionKey(card.modelId, vid);
    setInstallingSuggestion(key);
    // performInstall() resolves once the PREVIEW is ready (the confirm
    // modal is now showing) — the actual install can run far later, so
    // clearing this card's spinner belongs to that install's own
    // lifecycle (startCivitaiInstall's finally) and the cancel/auth-
    // redirect paths that can end this attempt before it ever starts,
    // not to this promise settling.
    performInstall(url || card.installUrl);
  };

  // After the key is saved, retry with the original URL — the server now reads
  // the freshly-saved key from settings. performInstall handles the bad-key
  // reopen by re-setting authPrompt.
  const retryAfterAuth = () => {
    const url = authPrompt.url;
    setAuthPrompt(null);
    if (url) performInstall(url);
  };

  // Install a LoRA from a HuggingFace repo. The family is auto-detected
  // server-side from the repo id/tags/filenames (Flux.2 Klein → flux2,
  // LTX-Video → ltx-video); HF_UNKNOWN_FAMILY surfaces as an inline picker
  // of image and video families rather than a dead-end toast.
  // Shared install runner: `family` is undefined for the first attempt
  // (server autodetects) and set to the override on the inline-confirm retry.
  const runHfInstall = useCallback(async (url, family) => {
    // Cross-guard against the curated video quick-install: both write the shared
    // hfProgress, so allowing them to overlap makes both progress readouts show
    // interleaved byte counts. Only one HF install runs at a time.
    if (!url || hfInstalling || installingVideoKey) return;
    setHfInstalling(true);
    setHfProgress(null);
    await installLoraFromHuggingfaceStream({ url, family, onProgress: setHfProgress })
      .then((sidecar) => {
        toast.success(`Installed ${sidecar.name}`);
        setLastInstalled(sidecar.name);
        setHfUrl('');
        setHfFamilyPrompt(null);
        refresh({ background: true });
      })
      .catch((err) => {
        // Autodetection failed but the install is otherwise valid — offer an
        // inline family picker rather than toast a dead-end or force LTX.
        // (Skip when we already tried with an explicit override.)
        if (err?.code === 'HF_UNKNOWN_FAMILY' && !family) {
          // The picker is the ENTIRE feedback for this branch — it deliberately
          // raises no toast. It renders inside the Discover panel, and the
          // install keeps running after the user leaves that tab, so surface
          // the tab too or the failure is completely silent.
          setView(discoverView);
          setHfFamilyPrompt(url);
        } else {
          toast.error(err?.message || 'HuggingFace install failed');
        }
      })
      .finally(() => { setHfInstalling(false); setHfProgress(null); });
  }, [hfInstalling, installingVideoKey, refresh]);

  const handleHfInstall = useCallback((e) => {
    e?.preventDefault?.();
    setHfFamilyPrompt(null);
    const url = hfUrl.trim();
    if (!url) return undefined;
    return requestLoraDownload('Install HuggingFace LoRA', url, 'huggingface', () => runHfInstall(url, undefined));
  }, [hfUrl, runHfInstall, requestLoraDownload]);

  // Quick-install a curated video LoRA suggestion. Routes through the HF
  // installer (not the Civitai one) with the card's known family. Tracks the
  // in-flight repo in its own state because the Civitai `installingSuggestion`
  // key is modelId/versionId-based — video installs have neither.
  const startVideoSuggestionInstall = useCallback(async (card) => {
    // Cross-guard against the form install (see runHfInstall) — one HF install
    // at a time so they don't clobber the shared hfProgress.
    if (!card?.installUrl || installingVideoKey || hfInstalling) return;
    setInstallingVideoKey(hfCardKey(card));
    setHfProgress(null);
    await installLoraFromHuggingfaceStream({
      url: card.installUrl,
      family: card.runnerFamily,
      file: card.file,
      onProgress: setHfProgress,
    })
      .then((sidecar) => {
        toast.success(`Installed ${sidecar.name}`);
        setLastInstalled(sidecar.name);
        refresh({ background: true });
      })
      .catch((err) => toast.error(err?.message || 'HuggingFace install failed'))
      .finally(() => { setInstallingVideoKey(null); setHfProgress(null); });
  }, [installingVideoKey, hfInstalling, refresh]);

  // Card carries its own family/file, so the preview forwards them and shows
  // the exact file "Quick install" is about to fetch — not a re-guess.
  const installVideoSuggestion = useCallback((card) => {
    if (!card?.installUrl || installingVideoKey || hfInstalling) return undefined;
    return requestLoraDownload(
      'Install video LoRA',
      card.installUrl,
      'huggingface',
      () => startVideoSuggestionInstall(card),
      { family: card.runnerFamily, file: card.file },
    );
  }, [installingVideoKey, hfInstalling, requestLoraDownload, startVideoSuggestionInstall]);

  return {
    installUrl, setInstallUrl, installing, handleInstall,
    hfUrl, setHfUrl, hfInstalling, hfProgress, hfFamilyPrompt, setHfFamilyPrompt, handleHfInstall, runHfInstall,
    authPrompt, setAuthPrompt, retryAfterAuth,
    installingSuggestion, installSuggestion,
    installingVideoKey, installVideoSuggestion,
    lastInstalled, setLastInstalled,
    requestLoraDownload,
    downloadConfirm, handleCancelDownloadConfirm, runDownloadConfirm,
  };
}
