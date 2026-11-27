import { latestMusicVideoReviewDraft } from '../../../../server/lib/musicVideo/musicVideoReviewDraft.js';
import { resolveStageParam } from '../../lib/musicVideoStages.js';
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router';
import { unfoldToAnchor } from '../../lib/unfoldToAnchor.js';
import { SETTINGS_TAB_IDS } from './projectSettingsTabs.js';

export default function useMusicVideoWorkspaceNavigation({
  selected, statusKnown, progress,
}) {
  const { projectId: routeProjectId, artifactId: routeArtifactId, stage: routeStage, sceneId: routeSceneId } = useParams();
  // Which stage tab is open. The URL is the source of truth; with none (or an
  // unknown one) the tab is the stage the project was in when it was opened,
  // pinned so a stage completing mid-session doesn't move the user off the tab
  // they are working in — the header's next action tracks the project instead.
  // The pin latches once readiness (or its failure) is known, so a done project
  // never pins to Cast & Sets; this workspace is mounted per project, so the
  // latch needs no project id.
  const openedStageRef = useRef(null);
  if (openedStageRef.current === null && statusKnown) {
    openedStageRef.current = latestMusicVideoReviewDraft(selected) && !selected.renderHistoryId ? 'review' : progress.current;
  }
  const pinnedStage = openedStageRef.current;
  // A shot's card lives on Shots, including links made when it lived on the Storyboard; the editor opens it in place.
  const sceneStage = resolveStageParam(routeStage) === 'editor' ? 'editor' : 'produce';
  const activeStage = routeSceneId ? sceneStage : (resolveStageParam(routeStage) || pinnedStage || progress.current);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = selected.id;
  // Contact sheet open state lives in the URL (?sheet=contact) so it survives a
  // reload and Back closes it.
  const contactSheetOpen = searchParams.get('sheet') === 'contact';
  const setContactSheetOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('sheet', 'contact'); else { next.delete('sheet'); next.delete('pending'); }
    return next;
  });
  const contactSheetPendingOnly = searchParams.get('pending') === '1';
  const setContactSheetPendingOnly = (on) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set('pending', '1'); else next.delete('pending');
    return next;
  });

  const openArtifact = (artifactId) => navigate(`/music-video/${encodeURIComponent(selected.id)}/${activeStage}/dev/${encodeURIComponent(artifactId)}`);
  const closeArtifact = () => navigate(`/music-video/${encodeURIComponent(selected?.id || routeProjectId)}/${activeStage}`);
  const openArtifactRecord = routeArtifactId
    ? (selected?.devArtifacts || []).find((a) => a.id === routeArtifactId && !a.deleted) || null
    : null;
  const artifactVersion = Number(searchParams.get('v')) || openArtifactRecord?.version || null;
  const setArtifactVersion = (version) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (version && version !== openArtifactRecord?.version) next.set('v', String(version)); else next.delete('v');
    return next;
  });
  // ---- stage plumbing -------------------------------------------------------
  // A header action that lands on a control (Attach a track, Set up production)
  // scrolls to and focuses it once its stage has rendered.
  const location = useLocation();
  // The stage whose panel has committed. Landing waits for it so it runs exactly once per link:
  // a second pass would press a React-state fold toggle again and close what the first opened.
  const [readyStage, setReadyStage] = useState(null);
  useEffect(() => {
    const anchor = location.hash.slice(1);
    if (!anchor || !selected || readyStage !== activeStage) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    // An anchor inside a folded section (Production review, a Publish card or
    // platform row) unfolds it first; a React-state fold renders a frame later.
    const land = () => {
      el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
      const focusable = el.matches('[tabindex], button, input, select, textarea, a') ? el : el.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a');
      focusable?.focus?.({ preventScroll: true });
    };
    if (unfoldToAnchor(el)) requestAnimationFrame(land);
    else land();
  }, [activeStage, readyStage, location.key, selectedId, !!selected]);
  // Edit shot (from the preview player) opens that shot's card on Shots, in the side panel; in the editor, in its inspector.
  const editShot = (sceneId) => {
    if (!selected) return;
    const search = searchParams.toString();
    navigate(`/music-video/${encodeURIComponent(selected.id)}/${sceneStage}/scene/${encodeURIComponent(sceneId)}${search ? `?${search}` : ''}`, { replace: activeStage === sceneStage });
  };
  const goToStage = (stage, anchor = null, params = null) => {
    // Preserve search params (e.g. ?play=, ?new=, ?sheet=) across tabs; `params` sets more (e.g. ?scenes=missing).
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(params || {})) next.set(key, value);
    const search = next.toString();
    navigate(`/music-video/${encodeURIComponent(selected.id)}/${stage}${search ? `?${search}` : ''}${anchor ? `#${anchor}` : ''}`, { replace: activeStage === stage });
  };
  // Project settings (render style, audio tools, autopilot, files) is a drawer
  // over the open step; `?mvPanel=<tab>` says it is open and on which tab.
  const settingsParam = searchParams.get('mvPanel');
  const settingsTab = SETTINGS_TAB_IDS.includes(settingsParam) ? settingsParam : null;
  const setSettingsTab = (tab) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (tab) next.set('mvPanel', tab);
    else next.delete('mvPanel');
    return next;
  }, { replace: !!tab && !!settingsTab });
  // The header's Autopilot button stands in for the attention row's Open: a run
  // waiting on its checkpoint opens Autopilot at the editor, like that row did.
  const openHeaderSettings = (tab) => {
    if (tab !== 'autopilot' || selected?.autonomousRun?.status !== 'awaiting-approval') { setSettingsTab(tab); return; }
    const next = new URLSearchParams(searchParams);
    next.set('mvPanel', 'autopilot');
    navigate({ search: `?${next}`, hash: '#mv-auto-edit' });
  };
  return { routeSceneId, sceneStage, activeStage, contactSheetOpen, setContactSheetOpen, contactSheetPendingOnly,
    setContactSheetPendingOnly, openArtifact, closeArtifact, openArtifactRecord,
    artifactVersion, setArtifactVersion, location, setReadyStage, editShot, goToStage,
    settingsTab, setSettingsTab, openHeaderSettings, routeArtifactId, navigate };
}
