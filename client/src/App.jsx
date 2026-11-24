import { Suspense, useEffect } from 'react';
import { isPublicGuestRoute } from './lib/publicGuestRoutes';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router';
import Layout from './components/Layout';
import { FullWidthMain, PaddedMain } from './components/PageShell';
import { getSettings, updateSettings, getSelfInstance } from './services/apiSystem.js';
import { NAV_COMMANDS } from '../../server/lib/navManifest.js';
import { previousPathRedirects, previousPathTarget } from './lib/previousPaths';
import BrailleSpinner from './components/BrailleSpinner';
import { readShellBootstrap } from './services/shellBootstrap.js';
import { lazyWithReload } from './utils/lazyWithReload';

// Direct links to other pages should not download the dashboard's grid/editor.
const Dashboard = lazyWithReload(() => import('./pages/Dashboard'));

// Neither /apps nor /ambient is the landing route, so keep them out of the eager
// entry chunk — lazy-load them like every other non-index page.
const Apps = lazyWithReload(() => import('./pages/Apps'));
const Ambient = lazyWithReload(() => import('./pages/Ambient'));

// Lazy load heavier pages for code splitting
// DevTools pages are large (~2300 lines total) so lazy load them
const AIProviders = lazyWithReload(() => import('./pages/AIProviders'));
const HistoryPage = lazyWithReload(() => import('./pages/HistoryPage'));
const RunnerPage = lazyWithReload(() => import('./pages/RunnerPage'));
const UsagePage = lazyWithReload(() => import('./pages/UsagePage'));
const ProcessesPage = lazyWithReload(() => import('./pages/ProcessesPage'));
const AgentsPage = lazyWithReload(() => import('./pages/AgentsPage'));
const DataDog = lazyWithReload(() => import('./pages/DataDog'));
const GitHub = lazyWithReload(() => import('./pages/GitHub'));
const Eidoverse = lazyWithReload(() => import('./pages/Eidoverse'));
const AppDetail = lazyWithReload(() => import('./pages/AppDetail'));
const FeatureAgents = lazyWithReload(() => import('./pages/FeatureAgents'));
const FeatureAgentDetail = lazyWithReload(() => import('./pages/FeatureAgentDetail'));
const CalendarPage = lazyWithReload(() => import('./pages/Calendar'));
const Messages = lazyWithReload(() => import('./pages/Messages'));
const StackerNews = lazyWithReload(() => import('./pages/StackerNews'));
const XPage = lazyWithReload(() => import('./pages/X'));
const IMessage = lazyWithReload(() => import('./pages/IMessage'));
const Tribe = lazyWithReload(() => import('./pages/Tribe'));
const Timeline = lazyWithReload(() => import('./pages/Timeline'));
const Goals = lazyWithReload(() => import('./pages/Goals'));
const OpenClawPage = lazyWithReload(() => import('./pages/OpenClaw'));
const ImageClean = lazyWithReload(() => import('./pages/ImageClean'));
const QuotaBurn = lazyWithReload(() => import('./pages/QuotaBurn'));
const VideoDownloaderPage = lazyWithReload(() => import('./pages/VideoDownloaderPage'));
const ChiefOfStaff = lazyWithReload(() => import('./pages/ChiefOfStaff'));
const Ask = lazyWithReload(() => import('./pages/Ask'));
const MediaGen = lazyWithReload(() => import('./pages/MediaGen'));
const ImageGen = lazyWithReload(() => import('./pages/ImageGen'));
const VideoGen = lazyWithReload(() => import('./pages/VideoGen'));
const PromptFromMediaPage = lazyWithReload(() => import('./pages/PromptFromMediaPage'));
const MediaHistory = lazyWithReload(() => import('./pages/MediaHistory'));
const MediaAnnotate = lazyWithReload(() => import('./pages/MediaAnnotate'));
const MediaCollections = lazyWithReload(() => import('./pages/MediaCollections'));
const MediaCollectionDetail = lazyWithReload(() => import('./pages/MediaCollectionDetail'));
const MediaCollectionSyncView = lazyWithReload(() => import('./pages/MediaCollectionSyncView'));
const SyncView = lazyWithReload(() => import('./pages/SyncView'));
const ThreejsModels = lazyWithReload(() => import('./pages/ThreejsModels'));
const HtmlPages = lazyWithReload(() => import('./pages/HtmlPages'));
const Media3D = lazyWithReload(() => import('./pages/Media3D'));
const BlenderModelDetail = lazyWithReload(() => import('./pages/BlenderModelDetail'));
const Media3DDetail = lazyWithReload(() => import('./pages/Media3DDetail'));
const ThreejsModelDetail = lazyWithReload(() => import('./pages/ThreejsModelDetail'));
const UniverseBuilder = lazyWithReload(() => import('./pages/UniverseBuilder'));
const Universes = lazyWithReload(() => import('./pages/Universes'));
const Authors = lazyWithReload(() => import('./pages/Authors'));
const Music = lazyWithReload(() => import('./pages/Music'));
const CreativeStudio = lazyWithReload(() => import('./pages/CreativeStudio'));
const Catalog = lazyWithReload(() => import('./pages/Catalog'));
const Rounds = lazyWithReload(() => import('./pages/Rounds'));
const SongBook = lazyWithReload(() => import('./pages/SongBook'));
const SongBookImport = lazyWithReload(() => import('./pages/SongBookImport'));
const SongBookViewer = lazyWithReload(() => import('./pages/SongBookViewer'));
const RoundEditor = lazyWithReload(() => import('./pages/RoundEditor'));
const RoundsGuide = lazyWithReload(() => import('./pages/RoundsGuide'));
const CatalogIngest = lazyWithReload(() => import('./pages/CatalogIngest'));
const CatalogIngredient = lazyWithReload(() => import('./pages/CatalogIngredient'));
const CreativeLibrary = lazyWithReload(() => import('./pages/CreativeLibrary'));
const CreativeCastImport = lazyWithReload(() => import('./pages/CreativeCastImport'));
const VideoTimeline = lazyWithReload(() => import('./pages/VideoTimeline'));
const VideoTimelineEditor = lazyWithReload(() => import('./pages/VideoTimelineEditor'));
const CreativeDirector = lazyWithReload(() => import('./pages/CreativeDirector'));
const CreativeDirectorDetail = lazyWithReload(() => import('./pages/CreativeDirectorDetail'));
const CreativeCommissions = lazyWithReload(() => import('./pages/CreativeCommissions'));
const CreativeCommissionDetail = lazyWithReload(() => import('./pages/CreativeCommissionDetail'));
const Game = lazyWithReload(() => import('./pages/Game'));
const MusicVideo = lazyWithReload(() => import('./pages/MusicVideo'));
const Sprites = lazyWithReload(() => import('./pages/Sprites'));
const MoodBoards = lazyWithReload(() => import('./pages/MoodBoards'));
const CodeAnimation = lazyWithReload(() => import('./pages/CodeAnimation'));
const MoodBoardDetail = lazyWithReload(() => import('./pages/MoodBoardDetail'));
const Storyboards = lazyWithReload(() => import('./pages/Storyboards'));
const StoryboardDetail = lazyWithReload(() => import('./pages/StoryboardDetail'));
const Decks = lazyWithReload(() => import('./pages/Decks'));
const DeckDetail = lazyWithReload(() => import('./pages/DeckDetail'));
const CreateApp = lazyWithReload(() => import('./pages/CreateApp'));
const Templates = lazyWithReload(() => import('./pages/Templates'));
const PromptManager = lazyWithReload(() => import('./pages/PromptManager'));
// Inbox (the capture form) is Brain's landing tab and its own lazy chunk; start
// it alongside the page chunk instead of after it renders, one round trip
// fewer before the form can take input on a phone.
const Brain = lazyWithReload(() => {
  if (/^\/brain(\/inbox)?\/?$/.test(window.location.pathname)) {
    import('./components/brain/tabs/InboxTab').catch(() => {});
  }
  return import('./pages/Brain');
});
const BrainScanReport = lazyWithReload(() => import('./pages/BrainScanReport'));
const Security = lazyWithReload(() => import('./pages/Security'));
const DigitalTwin = lazyWithReload(() => import('./pages/DigitalTwin'));
const Privacy = lazyWithReload(() => import('./pages/Privacy'));
const Agents = lazyWithReload(() => import('./pages/Agents'));
const Uploads = lazyWithReload(() => import('./pages/Uploads'));
const Settings = lazyWithReload(() => import('./pages/Settings'));
const VoiceStudio = lazyWithReload(() => import('./pages/VoiceStudio'));
const VoiceCallHost = lazyWithReload(() => import('./pages/VoiceCallHost'));
const ApiExplorer = lazyWithReload(() => import('./pages/ApiExplorer'));
const LocalLlmPlayground = lazyWithReload(() => import('./pages/LocalLlmPlayground'));
const Models = lazyWithReload(() => import('./pages/Models'));
const Shell = lazyWithReload(() => import('./pages/Shell'));
const BrowserPage = lazyWithReload(() => import('./pages/Browser'));
const Jira = lazyWithReload(() => import('./pages/Jira'));
const JiraReports = lazyWithReload(() => import('./pages/JiraReports'));
const DataManager = lazyWithReload(() => import('./pages/DataManager'));
const Insights = lazyWithReload(() => import('./pages/Insights'));
const Instances = lazyWithReload(() => import('./pages/Instances'));
const WorkspaceContexts = lazyWithReload(() => import('./pages/WorkspaceContexts'));
const SystemHealthPage = lazyWithReload(() => import('./pages/SystemHealthPage'));
const CapabilityMap = lazyWithReload(() => import('./pages/CapabilityMap'));
const MeatSpace = lazyWithReload(() => import('./pages/MeatSpace'));
const Post = lazyWithReload(() => import('./pages/Post'));
const Review = lazyWithReload(() => import('./pages/Review'));
const Loops = lazyWithReload(() => import('./pages/Loops'));
const CharacterSheet = lazyWithReload(() => import('./pages/CharacterSheet'));
const Wiki = lazyWithReload(() => import('./pages/Wiki'));
const RapidReaderPage = lazyWithReload(() => import('./pages/RapidReader'));
const WritersRoom = lazyWithReload(() => import('./pages/WritersRoom'));
const WritersRoomGuide = lazyWithReload(() => import('./pages/WritersRoomGuide'));
const Pipeline = lazyWithReload(() => import('./pages/Pipeline'));
const Sharing = lazyWithReload(() => import('./pages/Sharing'));
const Importer = lazyWithReload(() => import('./pages/Importer'));
const FableLoom = lazyWithReload(() => import('./pages/FableLoom'));
const FableLoomStory = lazyWithReload(() => import('./pages/FableLoomStory'));
const FableLoomHostedJoin = lazyWithReload(() => import('./pages/FableLoomHostedJoin'));
const StartStory = lazyWithReload(() => import('./pages/StartStory'));
const StoryBuilder = lazyWithReload(() => import('./pages/StoryBuilder'));
const PipelineSeries = lazyWithReload(() => import('./pages/PipelineSeries'));
const PipelineSeriesRoadmap = lazyWithReload(() => import('./pages/PipelineSeriesRoadmap'));
const PipelineEditorialChecks = lazyWithReload(() => import('./pages/PipelineEditorialChecks'));
const PipelineFindingRedirect = lazyWithReload(() => import('./pages/PipelineFindingRedirect'));
const PipelineReverseOutline = lazyWithReload(() => import('./pages/PipelineReverseOutline'));
const PipelineVoiceFingerprint = lazyWithReload(() => import('./pages/PipelineVoiceFingerprint'));
const PipelineContinuityBible = lazyWithReload(() => import('./pages/PipelineContinuityBible'));
const PipelineManuscriptEditor = lazyWithReload(() => import('./pages/PipelineManuscriptEditor'));
const PipelineExport = lazyWithReload(() => import('./pages/PipelineExport'));
const PipelineIssue = lazyWithReload(() => import('./pages/PipelineIssue'));
const EidoverseGuest = lazyWithReload(() => import('./pages/EidoverseGuest'));
const Login = lazyWithReload(() => import('./pages/Login'));
const NotFound = lazyWithReload(() => import('./pages/NotFound'));

// Loading fallback for lazy-loaded pages
const PageLoader = () => (
  <div className="flex items-center justify-center h-64">
    <BrailleSpinner text="Loading" />
  </div>
);

// Preserve query string + hash on a hand-written redirect.
function RedirectWithSearch({ to }) {
  const { search, hash, state } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} state={state} replace />;
}

// Generated from NAV_COMMANDS so a moved page's old path redirects by being
// declared beside the page (`previousPaths`), with no second table here.
const PREVIOUS_PATH_REDIRECTS = previousPathRedirects(NAV_COMMANDS);

function PreviousPathRedirect({ from, to, preserveSuffix }) {
  const { pathname, search, hash, state } = useLocation();
  return <Navigate to={previousPathTarget({ from, to, preserveSuffix }, { pathname, search, hash })} state={state} replace />;
}

// Canon page was folded into Universe Builder; redirect the old sub-route to
// the builder so deep-links and bookmarks keep working. Strips the trailing
// `/canon` (with optional trailing slash — React Router matches both forms,
// otherwise `/universes/abc/canon/` would self-loop), preserves the
// query string (e.g. `?series=<id>` filter), and adds `#canon` so the
// browser scrolls to the embedded canon section instead of the bible at the
// top of the builder (UniverseCanonSection renders with `id="canon"`).
function CanonRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={`${pathname.replace(/\/canon\/?$/, '')}${search}#canon`} replace />;
}

// Redirect a legacy universe canon mount (`/media/universe-builder/:id/canon`,
// `/universe-builder/:id/canon`) to the builder, forcing `#canon` to scroll the
// embedded canon section. The non-canon legacy paths are `previousPaths`.
function UniverseRouteRedirect({ fromPrefix, to }) {
  const { pathname, search } = useLocation();
  const rest = pathname.replace(fromPrefix, '');
  return <Navigate to={`${to}${rest.replace(/\/canon\/?$/, '')}${search}#canon`} replace />;
}

// The retired /ai/harnesses/:harnessId/connections[/:connectionId] drawer
// (#6369 → #7567): a connection id names a service, so a deep link into one
// lands on that service; the bare harness-scoped list lands on the harness.
function HarnessConnectionsRedirect() {
  const { harnessId, connectionId } = useParams();
  const { search, hash } = useLocation();
  const target = connectionId
    ? `/ai/services/${encodeURIComponent(connectionId)}`
    : `/ai/harnesses/${encodeURIComponent(harnessId)}`;
  return <Navigate to={`${target}${search}${hash}`} replace />;
}

// Normalize a tab-less /creative-director/:id URL to its overview tab while
// preserving any query string + hash. A bare `<Navigate to="overview">` would
// drop them; building the relative target from useLocation keeps deep-link
// state intact (the relative pathname still resolves the :id segment).
function CreativeDirectorOverviewRedirect() {
  const { search, hash, state } = useLocation();
  return <Navigate to={`overview${search}${hash}`} state={state} replace />;
}

// Force full reload on HMR — partial hot-replacement of the route tree
// causes stale lazy imports and React Router errors on nested paths
if (import.meta.hot) {
  import.meta.hot.decline();
}

// Self-heal timezone on first load: the server process runs under TZ=UTC, so
// if settings.timezone was never set the server fallback resolves to UTC and
// date-scoped features (daily log, schedulers) land on the wrong day. Push
// the browser's IANA zone once so remote/VPN clients don't need to visit
// Settings before their first entry is correct.
function useTimezoneBootstrap(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    readShellBootstrap('settings', () => getSettings({ silent: true })).then((s) => {
      if (cancelled || s?.timezone) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz || tz === 'UTC') return;
      return updateSettings({ timezone: tz });
    }).catch(() => null);
    return () => { cancelled = true; };
  }, [enabled]);
}

// Stamp the machine's instance name into the browser tab so multiple federated
// installs are distinguishable at a glance — "PortOS: {name}". Falls back to the
// static "PortOS" title (set in index.html) when the name is missing/unfetchable.
function useDocumentTitle(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    readShellBootstrap('selfInstance', () => getSelfInstance({ silent: true })).then((self) => {
      const name = self?.name?.trim();
      if (!cancelled && name) document.title = `PortOS: ${name}`;
    }).catch(() => null);
    return () => { cancelled = true; };
  }, [enabled]);
}

export default function App() {
  const { pathname } = useLocation();
  const isHostedAudienceRoute = isPublicGuestRoute(pathname);
  useTimezoneBootstrap(!isHostedAudienceRoute);
  useDocumentTitle(!isHostedAudienceRoute);

  const routeContent = (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/eidoverse/guest" element={<EidoverseGuest />} />
        {/* Chromeless world-only surface: same iframe hostUrl as /eidoverse, without
            a Safari top-level navigation to /eidoverse-host/ (stuck splash). */}
        <Route path="/eidoverse/solo" element={<Eidoverse />} />
        <Route path="/login" element={<Login />} />
        <Route path="/ambient" element={<Ambient />} />
        {/* Hosted audience devices need the full dynamic viewport, without the
            app chrome consuming part of the height or clipping the controls. */}
        <Route path="/fableloom/join" element={<FableLoomHostedJoin />} />
        <Route path="/" element={<Layout />}>
          <Route element={<PaddedMain />}>
            <Route index element={<Dashboard />} />
            <Route path="apps/create" element={<CreateApp />} />
            <Route path="voice/call-host" element={<VoiceCallHost />} />
            <Route path="imessage/:chatKey" element={<IMessage />} />
            <Route path="devtools/jira/reports" element={<JiraReports />} />
            <Route path="3d/:id" element={<Media3DDetail />} />
            <Route path="creative-commission/:id" element={<CreativeCommissionDetail />} />
            <Route path="mood-boards/:id" element={<MoodBoardDetail />} />
            <Route path="decks/:id" element={<DeckDetail />} />
            <Route path="pipeline/findings/:commentId" element={<PipelineFindingRedirect />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route element={<FullWidthMain />}>
            <Route path="apps" element={<Apps />} />
            <Route path="devtools/datadog" element={<DataDog />} />
            <Route path="devtools/github" element={<GitHub />} />
            <Route path="devtools/github/:tab" element={<GitHub />} />
            <Route path="devtools/github/:tab/:accountId/:threadId" element={<GitHub />} />
            <Route path="devtools/history" element={<HistoryPage />} />
            <Route path="devtools/image-clean" element={<ImageClean />} />
            <Route path="devtools/quota-burn" element={<QuotaBurn />} />
            <Route path="devtools/quota-burn/:familyId" element={<QuotaBurn />} />
            <Route path="devtools/runner" element={<RunnerPage />} />
            <Route path="devtools/usage" element={<UsagePage />} />
            <Route path="devtools/video-download" element={<VideoDownloaderPage />} />
            <Route path="devtools/processes" element={<ProcessesPage />} />
            <Route path="devtools/agents" element={<AgentsPage />} />
            <Route path="eidoverse" element={<Eidoverse />} />
            {/* AI Providers is three views over one page (#7567): Presets (the
                stored records — the index /ai lands on), Harnesses and Services.
                Every overlay is deep-linkable over the same page: /ai/presets/new
                creates, /ai/presets/:presetId edits, /ai/services/new adds a
                service, /ai/services/:serviceSlug opens one, /ai/harnesses/:harnessId
                opens one harness card, and /ai/fleet walks through a remote GPU
                host. A preset id is slugified from its display name, so a preset
                named "New" gets the id `new` and is shadowed by the static create
                route under /ai/presets — the legacy /ai/edit/:providerId alias is
                kept as a WORKING route (not a redirect) so that one record stays
                reachable; the page's own edit links use it for that id only. */}
            <Route path="ai/presets" element={<AIProviders />} />
            <Route path="ai/presets/new" element={<AIProviders />} />
            <Route path="ai/presets/:presetId" element={<AIProviders />} />
            <Route path="ai/presets/moa/:moaId" element={<AIProviders />} />
            <Route path="ai/edit/:providerId" element={<AIProviders />} />
            <Route path="ai/fleet" element={<AIProviders />} />
            <Route path="ai/harnesses" element={<AIProviders />} />
            <Route path="ai/harnesses/:harnessId" element={<AIProviders />} />
            <Route path="ai/services" element={<AIProviders />} />
            <Route path="ai/services/new" element={<AIProviders />} />
            <Route path="ai/services/:serviceSlug" element={<AIProviders />} />
            {/* /prompts and legacy ?tab= links redirect onto /prompts/:tab inside the page. */}
            <Route path="prompts" element={<PromptManager />} />
            <Route path="prompts/:tab" element={<PromptManager />} />
            <Route path="cos/:tab/:agentId" element={<ChiefOfStaff />} />
            <Route path="cos/:tab" element={<ChiefOfStaff />} />
            <Route path="calendar/:tab" element={<CalendarPage />} />
            <Route path="brain/links/:id/scan-report" element={<BrainScanReport />} />
            <Route path="brain/:tab/:recordType/:recordId" element={<Brain />} />
            <Route path="brain/:tab" element={<Brain />} />
            <Route path="digital-twin/:tab" element={<DigitalTwin />} />
            <Route path="privacy/:tab" element={<Privacy />} />
            <Route path="goals/:tab" element={<Goals />} />
            <Route path="goals/:tab/:goalId" element={<Goals />} />
            <Route path="feature-agents" element={<FeatureAgents />} />
            <Route path="feature-agents/create" element={<FeatureAgentDetail />} />
            <Route path="feature-agents/:id/:tab" element={<FeatureAgentDetail />} />
            <Route path="apps/:appId" element={<AppDetail />} />
            <Route path="apps/:appId/:tab" element={<AppDetail />} />
            <Route path="templates" element={<Templates />} />
            <Route path="security" element={<Security />} />
            <Route path="settings/:tab" element={<Settings />} />
            {/* The FaceTime call host runs in its own tab on the Mac — device
                permissions and setSinkId need a real browser profile, and the
                page holds a Web Lock so a second tab cannot double-answer. */}
            <Route path="voices" element={<VoiceStudio />} />
            <Route path="voices/:profileId" element={<VoiceStudio />} />
            <Route path="api-reference/:tab" element={<ApiExplorer />} />
            {/* Performance owns task views rather than making one long page. The
                selected result route is more specific so a slash-containing model
                id stays inside the reversible assessment key segment. */}
            <Route path="models/llms-runtimes/:recordId?" element={<Models fixedTab="llms-runtimes" />} />
            <Route path="models/performance/results/:assessmentKey" element={<Models fixedTab="performance" />} />
            <Route path="models/performance/:view" element={<Models fixedTab="performance" />} />
            {/* A tab's drill-down (today: the LoRA dataset workbench) renders through
                Models itself, so it keeps the section header and tab bar — see
                TAB_DETAIL there. */}
            <Route path="models/:tab" element={<Models />} />
            <Route path="models/:tab/:recordId" element={<Models />} />
            <Route path="models/decision-classifiers/jev/:taskView" element={<Models fixedTab="decision-classifiers" fixedRecordId="jev" />} />
            <Route path="models/llms/jev/:taskView" element={<Models fixedTab="llms" fixedRecordId="jev" />} />
            <Route path="local-llm/playground" element={<LocalLlmPlayground />} />
            <Route path="uploads" element={<Uploads />} />
            <Route path="shell" element={<Shell />} />
            {/* The iTerm2 view (#8114): the static `iterm` segment outranks :sessionId. */}
            <Route path="shell/iterm" element={<Shell />} />
            <Route path="shell/iterm/:itermSessionId" element={<Shell />} />
            <Route path="shell/:sessionId" element={<Shell />} />
            <Route path="browser" element={<BrowserPage />} />
            <Route path="insights/:tab" element={<Insights />} />
            <Route path="instances" element={<Instances />} />
            <Route path="workspace-contexts" element={<WorkspaceContexts />} />
            <Route path="workspace-contexts/:appId" element={<WorkspaceContexts />} />
            <Route path="system-resources/:tab" element={<SystemHealthPage />} />
            <Route path="capabilities" element={<CapabilityMap />} />
            <Route path="loops" element={<Loops />} />
            <Route path="meatspace/:tab" element={<MeatSpace />} />
            <Route path="post/:tab" element={<Post />} />
            <Route path="post/:tab/:subtab" element={<Post />} />
            {/* Third segment carries the practice mode for the memory tab
                (/post/memory/:itemId/:mode) so a drill is directly linkable — the
                same "selection lives in the URL" contract Morse/Wordplay already
                satisfy with their :mode subtab (issue #3249). */}
            <Route path="post/:tab/:subtab/:mode" element={<Post />} />
            <Route path="review" element={<Review />} />
            <Route path="review/:actionId" element={<Review />} />
            {/* :chatKey is only used by the imessage tab; other tabs strip a stray second segment. */}
            <Route path="messages/:tab/:chatKey" element={<Messages />} />
            <Route path="messages/:tab" element={<Messages />} />
            <Route path="stacker-news" element={<StackerNews />} />
            <Route path="stacker-news/:accountId/:tab" element={<StackerNews />} />
            <Route path="x" element={<XPage />} />
            <Route path="x/:accountId/:tab" element={<XPage />} />
            <Route path="tribe" element={<Tribe />} />
            <Route path="timeline" element={<Timeline />} />
            <Route path="timeline/:date" element={<Timeline />} />
            <Route path="openclaw" element={<OpenClawPage />} />
            <Route path="devtools/jira" element={<Jira />} />
            <Route path="data" element={<DataManager />} />
            <Route path="character" element={<CharacterSheet />} />
            <Route path="ask" element={<Ask />} />
            <Route path="ask/:conversationId" element={<Ask />} />
            <Route path="media" element={<MediaGen />}>
              <Route index element={<Navigate to="/media/image" replace />} />
              <Route path="image" element={<ImageGen />} />
              <Route path="prompt" element={<PromptFromMediaPage />} />
              <Route path="prompt/:examinationId" element={<PromptFromMediaPage />} />
              <Route path="history" element={<MediaHistory />} />
              <Route path="annotate" element={<MediaAnnotate />} />
              <Route path="annotate/:mediaKey" element={<MediaAnnotate />} />
              <Route path="collections" element={<MediaCollections />} />
              <Route path="collections/:id" element={<MediaCollectionDetail />} />
              <Route path="collections/:id/sync" element={<MediaCollectionSyncView />} />
              <Route path="timeline" element={<VideoTimeline />} />
              <Route path="timeline/:projectId" element={<VideoTimelineEditor />} />
              <Route path="threejs" element={<ThreejsModels />} />
              <Route path="threejs/:id" element={<ThreejsModelDetail />} />
              <Route path="universe-builder/:universeId/canon" element={<UniverseRouteRedirect fromPrefix={/^\/media\/universe-builder/} to="/universes" />} />
            </Route>
            {/* Sprite Manager — a top-level Create page (moved out of the Media
                Gen tabs). The record id is the URL, per the ID-based deep-linking
                convention. */}
            <Route path="sprites" element={<Sprites />} />
            <Route path="sprites/:id" element={<Sprites />} />
            {/* Creative Director — a top-level Create page (moved out of the
                Media Gen tabs); /video is its browse-only view. */}
            {/* VideoGen still uses the Media Gen tab shell (header + tabs +
                overflow-auto body); VideoGen has no internal scroller of its
                own, so rendering it bare in the full-width main clips the form. */}
            <Route path="video/generate" element={<MediaGen />}>
              <Route index element={<VideoGen />} />
            </Route>
            <Route path="creative-director" element={<CreativeDirector />} />
            <Route path="creative-director/:id/:tab/:sceneId" element={<CreativeDirectorDetail />} />
            <Route path="creative-director/:id/:tab" element={<CreativeDirectorDetail />} />
            {/* Music Video — a top-level Create page (moved out of the Media Gen
                tabs). The project id is the URL, per the ID-based deep-linking
                convention. */}
            <Route path="music-video" element={<MusicVideo />} />
            <Route path="music-video/:projectId" element={<MusicVideo />} />
            {/* Stage tab (story | setup | board | cast-sets | previz | produce | review | publish; legacy aliases such as compose still resolve); an unknown stage opens the project's default. */}
            <Route path="music-video/:projectId/:stage" element={<MusicVideo />} />
            <Route path="music-video/:projectId/:stage/scene/:sceneId" element={<MusicVideo />} />
            {/* The Storyboard step's open panel. */}
            <Route path="music-video/:projectId/:stage/panel/:panelId" element={<MusicVideo />} />
            <Route path="music-video/:projectId/scene/:sceneId" element={<MusicVideo />} />
            <Route path="music-video/:projectId/dev/:artifactId" element={<MusicVideo />} />
            <Route path="music-video/:projectId/:stage/dev/:artifactId" element={<MusicVideo />} />
            {/* 3D — a top-level Create page (moved out of the Media Gen tabs). The
                record id is the URL, per the ID-based deep-linking convention. */}
            <Route path="3d" element={<Media3D />} />
            <Route path="3d/blender/:id/:tab?" element={<BlenderModelDetail />} />
            {/* Index (list) hosts the create drawer at /new; `:id` is now a routed
                detail page (editable config + render history), not a sidebar edit
                drawer. React Router ranks the static `new` segment above `:id`, so
                the index reads `new` off the pathname while every real id lands on
                the detail page. */}
            <Route path="creative-commission" element={<CreativeCommissions />} />
            <Route path="creative-commission/new" element={<CreativeCommissions />} />
            <Route path="html-pages" element={<HtmlPages />} />
            <Route path="html-pages/runs" element={<HtmlPages />} />
            <Route path="html-pages/gallery" element={<HtmlPages />} />
            <Route path="game" element={<Game />} />
            <Route path="game/:id" element={<Game />} />
            <Route path="wiki/:tab" element={<Wiki />} />
            <Route path="rapid-reader" element={<RapidReaderPage />} />
            <Route path="rapid-reader/:id" element={<RapidReaderPage />} />
            {/* `/universes` is the universe index (list/table). The editor lives
                at `/universes/:universeId`; `new` is the create-mode sentinel
                (UniverseBuilder treats it as no-id → blank draft). Universe ids are
                UUIDs, so `new` can never collide with a real record. */}
            <Route path="rounds" element={<Rounds />} />
            <Route path="rounds/guide" element={<RoundsGuide />} />
            <Route path="rounds/:id" element={<RoundEditor />} />
            <Route path="songbook" element={<SongBook />} />
            <Route path="songbook/import" element={<SongBookImport />} />
            <Route path="songbook/:id" element={<SongBookViewer />} />
            <Route path="create/media" element={<CreativeStudio studio="media" />} />
            <Route path="create/story" element={<CreativeStudio studio="story" />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="catalog/ingest" element={<CatalogIngest />} />
            <Route path="catalog/:type/:id" element={<CatalogIngredient />} />
            <Route path="catalog/casting" element={<CreativeLibrary key="casting" libraryId="casting" />} />
            <Route path="casting/import" element={<CreativeCastImport />} />
            <Route path="casting/:id/:tab?" element={<CatalogIngredient />} />
            <Route path="catalog/environments" element={<CreativeLibrary key="environments" libraryId="environments" />} />
            <Route path="environments/:id/:tab?" element={<CatalogIngredient />} />
            <Route path="catalog/objects" element={<CreativeLibrary key="objects" libraryId="objects" />} />
            <Route path="objects/:id/:tab?" element={<CatalogIngredient />} />
            <Route path="code-animation" element={<CodeAnimation />} />
            <Route path="code-animation/gallery" element={<CodeAnimation />} />
            <Route path="code-animation/drafts/:draftId" element={<CodeAnimation />} />
            <Route path="code-animation/:jobId" element={<CodeAnimation />} />
            <Route path="code-animation/production" element={<CodeAnimation />} />
            <Route path="code-animation/production/films/:filmId/:tab?/:shotId?" element={<CodeAnimation />} />
            <Route path="code-animation/production/:projectId" element={<CodeAnimation />} />
            <Route path="mood-boards" element={<MoodBoards />} />
            <Route path="storyboards" element={<Storyboards />} />
            <Route path="storyboards/:id" element={<StoryboardDetail />} />
            <Route path="storyboards/:id/panel/:panelId" element={<StoryboardDetail />} />
            <Route path="decks" element={<Decks />} />
            <Route path="universes" element={<Universes />} />
            <Route path="universes/new" element={<UniverseBuilder />} />
            <Route path="universes/:universeId" element={<UniverseBuilder />} />
            <Route path="universes/:universeId/sync" element={<SyncView kind="universe" param="universeId" backPath="/universes" />} />
            <Route path="writers-room" element={<WritersRoom />} />
            <Route path="writers-room/guide" element={<WritersRoomGuide />} />
            <Route path="sharing" element={<Sharing />} />
            <Route path="sharing/:section" element={<Sharing />} />
            <Route path="sharing/:section/:bucketId" element={<Sharing />} />
            <Route path="importer" element={<Importer />} />
            <Route path="fableloom" element={<FableLoom />} />
            <Route path="fableloom/:loomId" element={<FableLoomStory />} />
            <Route path="fableloom/:loomId/:episodeId/outline" element={<FableLoomStory view="outline" />} />
            <Route path="fableloom/:loomId/:episodeId/board" element={<FableLoomStory view="board" />} />
            <Route path="fableloom/:loomId/:episodeId" element={<FableLoomStory />} />
            <Route path="fableloom/:loomId/:episodeId/:nodeId" element={<FableLoomStory />} />
            <Route path="start-story" element={<StartStory />} />
            <Route path="story-builder" element={<StoryBuilder />} />
            <Route path="story-builder/:storyId/:step" element={<StoryBuilder />} />
            {/* Authors is a single master-detail page: the index + editor share one
                component, so selection rides `:authorId` (which also captures the
                `new` create-mode sentinel — author ids are UUIDs, so it can't
                collide). A bare `/authors` is the idle index. */}
            <Route path="authors" element={<Authors />} />
            <Route path="authors/:authorId" element={<Authors />} />
            {/* Music is tabbed (`:tab`); each tab's master-detail selection lives
                at `/music/:tab/:id` (`new` = create sentinel). */}
            <Route path="music" element={<Music />} />
            <Route path="music/:tab" element={<Music />} />
            <Route path="music/:tab/:id" element={<Music />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="pipeline/editorial-checks" element={<PipelineEditorialChecks />} />
            <Route path="pipeline/series/:seriesId" element={<PipelineSeries />} />
            <Route path="pipeline/series/:seriesId/roadmap" element={<PipelineSeriesRoadmap />} />
            <Route path="pipeline/series/:seriesId/reverse-outline" element={<PipelineReverseOutline />} />
            <Route path="pipeline/series/:seriesId/voice-fingerprint" element={<PipelineVoiceFingerprint />} />
            <Route path="pipeline/series/:seriesId/continuity-bible" element={<PipelineContinuityBible />} />
            {/* Splat (not a :param route) so navigating between issues reuses the
                same component instance instead of remounting + refetching. */}
            <Route path="pipeline/series/:seriesId/manuscript/*" element={<PipelineManuscriptEditor />} />
            <Route path="pipeline/series/:seriesId/export" element={<PipelineExport />} />
            <Route path="pipeline/series/:seriesId/sync" element={<SyncView kind="series" param="seriesId" backPath="/pipeline" />} />
            <Route path="pipeline/issues/:issueId/:stage" element={<PipelineIssue />} />
            <Route path="writers-room/works/:workId" element={<WritersRoom />} />
            <Route path="agents" element={<Agents />} />
            <Route path="agents/:agentId" element={<Agents />} />
            <Route path="agents/:agentId/:tab" element={<Agents />} />
          </Route>
          {/* One redirect per NAV_COMMANDS[].previousPaths entry (server/lib/navManifest.js):
              declaring the old path when a page moves IS its redirect. Only redirects
              with their own logic are written by hand below. */}
          {PREVIOUS_PATH_REDIRECTS.map((redirect) => (
            <Route key={redirect.from} path={redirect.from.slice(1)} element={<PreviousPathRedirect {...redirect} />} />
          ))}
          <Route path="devtools" element={<Navigate to="/devtools/agents" replace />} />
          <Route path="ai/new" element={<RedirectWithSearch to="/ai/presets/new" />} />
          <Route path="ai/harnesses/:harnessId/connections" element={<HarnessConnectionsRedirect />} />
          <Route path="ai/harnesses/:harnessId/connections/:connectionId" element={<HarnessConnectionsRedirect />} />
          <Route path="cos" element={<Navigate to="/cos/tasks" replace />} />
          <Route path="calendar" element={<Navigate to="/calendar/agenda" replace />} />
          <Route path="brain" element={<Navigate to="/brain/inbox" replace />} />
          <Route path="digital-twin" element={<Navigate to="/digital-twin/overview" replace />} />
          <Route path="privacy" element={<Navigate to="/privacy/overview" replace />} />
          <Route path="goals" element={<Navigate to="/goals/tree" replace />} />
          <Route path="feature-agents/:id" element={<Navigate to="overview" replace />} />
          <Route path="settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="api-reference" element={<Navigate to="/api-reference/catalog" replace />} />
          <Route path="models" element={<Navigate to="/models/llms" replace />} />
          <Route path="insights" element={<Navigate to="/insights/overview" replace />} />
          <Route path="meatspace" element={<Navigate to="/meatspace/overview" replace />} />
          <Route path="post" element={<Navigate to="/post/launcher" replace />} />
          <Route path="messages" element={<Navigate to="/messages/inbox" replace />} />
          {/* :id with no tab lands on the overview tab, carrying any query string
              + hash, so /creative-director/abc?x#y → /creative-director/abc/overview?x#y. */}
          <Route path="creative-director/:id" element={<CreativeDirectorOverviewRedirect />} />
          <Route path="wiki" element={<RedirectWithSearch to="/wiki/overview" />} />
          <Route path="universes/:universeId/canon" element={<CanonRedirect />} />
          <Route path="universe-builder/:universeId/canon" element={<UniverseRouteRedirect fromPrefix={/^\/universe-builder/} to="/universes" />} />
          <Route path="story-builder/:storyId" element={<Navigate to="idea" replace />} />
          <Route path="pipeline/issues/:issueId" element={<Navigate to="idea" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
  return routeContent;
}
