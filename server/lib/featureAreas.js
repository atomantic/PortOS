// Catalog of PortOS feature areas: which routes, nav sections and source globs belong to which area, so usage can be turned into a priority tier per area.
//
// Pure data and lookups, no I/O (same shape as navManifest.js and instanceFeatureRegistry.js). An area is optional
// when it carries an `instanceFeatureId` (a Settings > Features toggle owns it) and core otherwise.
//
// Resolution rules:
//   - `areaForNavPath` tries the longest `navPathPrefixes` match, then the nav command's `feature`, then its
//     section via `navSections`; a path no area owns (the dashboard) is `null`.
//   - `areasForFile` returns every area whose `codeGlobs` match a repo-relative path. A file in no area is shared
//     code. Globs of two areas must not claim the same tracked file (guarded in featureAreaCatalog.test.js): an audit
//     drops a dormant area by subtracting its globs, which would take a shared file away from the other area too.
//
// path.posix.matchesGlob matches case-insensitively on macOS and Windows but case-sensitively on Linux, so a glob must
// give the same answer either way: no letter ranges (`[A-Z]`), and carve a sibling out with `!(Prefix*)` instead.
//
// API traffic is deliberately NOT a field here: dashboard widgets and sidebar badges call most feature APIs on every
// load, and a password-free install cannot tell an agent's request from a human's. Usage is page dwell on a nav route.
//
// test/guards/repo/featureAreaCatalog.test.js is the contract: every nav path resolves, every instance feature has an area (or is listed in
// INSTANCE_FEATURES_WITHOUT_AREA), and every glob still matches a tracked file, so a rename fails a test instead of
// silently emptying an area.
import { posix } from 'node:path';
import { getNavCommandForPath } from './navManifest.js';

const area = ({ navSections = [], navPathPrefixes = [], codeGlobs, ...rest }) => Object.freeze({
  ...rest,
  navSections: Object.freeze([...navSections]),
  navPathPrefixes: Object.freeze([...navPathPrefixes]),
  codeGlobs: Object.freeze([...codeGlobs]),
});

// `cos-task-templates` is a form toggle inside Chief of Staff with no code of its own to rank.
export const INSTANCE_FEATURES_WITHOUT_AREA = Object.freeze(['cos-task-templates']);

// Nav paths no area owns, so the area guard stays total without a lazy catch-all.
export const NAV_PATHS_WITHOUT_AREA = Object.freeze([
  '/', // Dashboard: composes widgets from every area, so it belongs to none.
]);

export const FEATURE_AREAS = Object.freeze([
  // Optional areas: one per instance feature that owns code.
  area({
    id: 'post', label: 'POST', instanceFeatureId: 'post',
    codeGlobs: [
      'server/lib/post!(gres*)',
      'server/lib/db/schema/post.js',
      'server/routes/meatspacePost*',
      'server/services/meatspace/meatspacePost*',
      'server/services/{postActivityStreak,postRunDb,postRunStore,postTrainingLogStore}*',
      'client/src/pages/Post.jsx',
      'client/src/components/meatspace/post/**',
      'client/src/components/meatspace/tabs/PostTab.jsx',
      'client/src/lib/post!(gres*)',
    ],
  }),
  area({
    id: 'autobiography', label: 'Autobiography', instanceFeatureId: 'autobiography',
    codeGlobs: [
      'server/{routes,services}/autobiography*',
      'client/src/components/digital-twin/tabs/AutobiographyTab.jsx',
    ],
  }),
  area({
    id: 'datadog', label: 'DataDog', instanceFeatureId: 'datadog',
    codeGlobs: [
      'server/{routes,services}/datadog*',
      'client/src/pages/DataDog.jsx',
      'client/src/components/apps/tabs/DatadogTab.jsx',
    ],
  }),
  area({
    id: 'jira', label: 'JIRA', instanceFeatureId: 'jira',
    codeGlobs: [
      'server/{routes,services}/jira*',
      'client/src/pages/Jira*',
      'client/src/components/apps/JiraConfigPanel.jsx',
      'client/src/components/apps/tabs/JiraTab.jsx',
      'scripts/ops/jira-*',
    ],
  }),
  area({
    id: 'eidoverse', label: 'Eidoverse', instanceFeatureId: 'eidoverse',
    codeGlobs: [
      'server/{lib,routes,services}/eidoverse*',
      'server/services/eidoverse*/**',
      'server/sockets/eidoverse*',
      'client/src/pages/Eidoverse*',
      'client/src/components/eidoverse/**',
      'client/src/components/musicVideo/EidoverseVideoPanel.jsx',
      'client/src/{lib,hooks}/{eidoverse,useEidoverse}*',
      'scripts/eidoverse*',
      'scripts/lib/eidoverse*',
    ],
  }),
  area({
    id: 'jev', label: 'JEV decision classifier', instanceFeatureId: 'jev',
    navPathPrefixes: ['/models/decision-classifiers/jev'],
    codeGlobs: [
      'server/{lib,services}/jev*',
      'client/src/components/models/Jev*',
      'client/src/lib/jev*',
      'scripts/{jev-corpus,setup-jev}.js',
      'scripts/ml/*jev*',
    ],
  }),
  area({
    id: 'laya-mlx', label: 'Laya MLX', instanceFeatureId: 'laya-mlx',
    navPathPrefixes: ['/models/decision-classifiers/laya-mlx'],
    codeGlobs: [
      'server/{lib,services}/layaMlx*',
      'client/src/components/models/LayaMlxPanel.jsx',
      'scripts/ml/*laya*',
    ],
  }),
  area({
    id: 'gsd', label: 'GSD', instanceFeatureId: 'gsd',
    codeGlobs: [
      'server/routes/gsd*',
      'server/services/gsd*',
      'client/src/components/gsd/**',
      'client/src/components/{apps,cos}/tabs/Gsd*',
      'client/src/services/apiGSD.js',
    ],
  }),
  area({
    id: 'openclaw', label: 'OpenClaw', instanceFeatureId: 'openclaw',
    codeGlobs: [
      'server/routes/openclaw*',
      'server/integrations/openclaw/**',
      'client/src/pages/OpenClaw*',
      'client/src/hooks/useOpenClaw*',
      'client/src/services/apiOpenClaw.js',
    ],
  }),
  area({
    id: 'health', label: 'Health (MeatSpace)', instanceFeatureId: 'health',
    codeGlobs: [
      'server/lib/{meatspace,appleHealth,genome,curatedGenome}*',
      'server/routes/meatspace!(Post*)',
      'server/routes/{appleHealth,genome,mortalloom}*',
      'server/services/meatspace/!(meatspacePost*)',
      'server/services/{appleHealth,clinvar,epigenetic,genome,mortalLoom}*',
      'client/src/pages/MeatSpace.jsx',
      'client/src/components/meatspace/!(post|tabs)',
      'client/src/components/meatspace/tabs/!(PostTab*)',
      'client/src/components/meatspace/tabs/*/**',
      'client/src/components/{MortalLoomBanner,DeathClockCountdown,DeathClockWidget,useDeathClock}*',
      'client/src/components/dashboard/builtins/MeatSpaceStreakWidget.jsx',
      'client/src/components/settings/MortalLoomTab.jsx',
      'client/src/components/insights/GenomeHealthTab.jsx',
      'client/src/services/api{Meatspace,MortalLoom}.js',
    ],
  }),
  area({
    id: 'iterm', label: 'iTerm2 sessions', instanceFeatureId: 'iterm',
    navPathPrefixes: ['/shell/iterm'],
    codeGlobs: [
      'server/{lib,routes,services,sockets}/iterm*',
      'client/src/components/shell/{Iterm*,useItermSession}*',
    ],
  }),
  area({
    id: 'rigging', label: 'Rigging', instanceFeatureId: 'rigging',
    codeGlobs: [
      'server/{lib,routes}/rigging*',
      'server/services/rigging/**',
      'client/src/components/settings/RiggingRuntimeCard.jsx',
      'client/src/lib/rigging*',
      'client/src/services/apiRigging.js',
      'scripts/ml/*rigging*',
    ],
  }),
  area({
    id: 'docker-containment', label: 'Docker containment', instanceFeatureId: 'docker-containment',
    codeGlobs: [
      'server/{lib,routes,services}/dockerContainment*',
      'client/src/components/settings/DockerContainmentCard.jsx',
      'client/src/services/apiDockerContainment.js',
    ],
  }),
  area({
    id: 'facetime', label: 'FaceTime Audio', instanceFeatureId: 'facetime',
    codeGlobs: [
      'server/services/voice/facetimeBridge*',
      'server/native/facetime-ax/**',
      'scripts/setup-facetime.js',
      'client/src/pages/VoiceCallHost.jsx',
      'client/src/components/settings/voice/VoiceFaceTimeSection.jsx',
    ],
  }),
  area({
    id: 'imessage', label: 'iMessage', instanceFeatureId: 'imessage',
    codeGlobs: [
      'server/{routes,services}/imessage*',
      'client/src/components/messages/IMessage*',
    ],
  }),
  area({
    id: 'signal', label: 'Signal', instanceFeatureId: 'signal',
    codeGlobs: [
      'server/{lib,routes,services}/signal*',
      'client/src/components/messages/Signal*',
    ],
  }),
  area({
    id: 'x', label: 'X', instanceFeatureId: 'x',
    codeGlobs: [
      'server/{routes,services}/x.*',
      'server/services/xBrowser*',
      'server/integrations/x/**',
      'server/lib/xPostMedia*',
      'server/lib/db/schema/x.js',
      'client/src/pages/X.jsx',
    ],
  }),
  area({
    id: 'stacker-news', label: 'Stacker News', instanceFeatureId: 'stacker-news',
    codeGlobs: [
      'server/{routes,services}/stackerNews*',
      'server/integrations/stackerNews/**',
      'server/lib/db/schema/stackerNews.js',
      'client/src/pages/StackerNews.jsx',
      'client/src/services/apiStackerNews.js',
    ],
  }),
  area({
    id: 'beeper', label: 'Beeper', instanceFeatureId: 'beeper',
    codeGlobs: [
      'server/{lib,routes}/beeper*',
      'server/lib/db/schema/beeper.js',
      'server/services/beeper/**',
      'client/src/components/messages/{BeeperTab.jsx,beeper/**}',
      'client/src/components/tribe/BeeperIdentitiesPanel.jsx',
      'client/src/{hooks,lib}/{useBeeper,beeper}*',
      'client/src/services/apiBeeper.js',
    ],
  }),

  // Core areas: always installed, so a core area never learns below P2.
  area({
    id: 'music-video', label: 'Music video',
    navPathPrefixes: ['/music-video'],
    codeGlobs: [
      'server/routes/{musicVideo,filmRoutes,filmStyles,continuousVideoEpisode}*',
      'server/lib/{musicVideo,film,shot,previousShotNote}*',
      'server/lib/musicVideo/**',
      'server/services/{musicVideo,film,previz}*',
      'server/services/{musicVideo,film}/**',
      'client/src/pages/MusicVideo*',
      'client/src/components/musicVideo/!(EidoverseVideoPanel*)',
      'client/src/components/musicVideo/*/**',
      'client/src/{hooks,lib}/{useMusicVideo,musicVideo,useFilm,film,shot}*',
      'client/src/services/apiMusicVideo.js',
    ],
  }),
  area({
    id: 'media-gen', label: 'Media generation',
    navPathPrefixes: ['/media', '/video', '/html-pages', '/code-animation', '/sprites', '/3d'],
    codeGlobs: [
      'server/routes/{image,media,video,htmlPages,htmlComposition,codeAnimation,sprites,threejs,loras}*',
      'server/lib/mediaModels/**',
      'server/lib/{image,media,video,threejs,sprite,html,lora,flux,runway,higgsfield,grok,fal,photoreal}*',
      'server/services/{image,media,video,htmlPages,codeAnimation,lora,sprite,threejs,runway,higgsfield,fal,grok}*',
      'server/services/{imageGen,imageTo3d,mediaCollections,mediaJobQueue,mediaAssetIndex,videoGen,videoTimeline,htmlPages,htmlComposition,codeAnimation,sprites,threejsModels,blenderModels,blenderWorkspace,generatedPreview}/**',
      'server/services/blenderInstaller*',
      'client/src/pages/{Media,Image,Video,HtmlPages,CodeAnimation,Sprites,Threejs,Loras,PromptFromMedia}*',
      'client/src/components/{imageGen,videoGen,media,htmlPages,codeAnimation,sprites,threejsModels,graph3d,loras,blenderModels,video}/**',
      'client/src/{hooks,lib}/{useImage,useVideo,image,video,threejs,sprite,blender,glb,lora}*',
    ],
  }),
  area({
    id: 'story-studio', label: 'Story studio',
    navPathPrefixes: [
      '/start-story', '/story-builder', '/rounds', '/writers-room', '/pipeline', '/sharing',
      '/importer', '/authors', '/universes', '/decks', '/mood-boards', '/storyboards', '/voices', '/fableloom', '/game',
    ],
    codeGlobs: [
      'server/routes/{pipeline,universeBuilder}/**',
      'server/routes/{pipeline,rounds,writersRoom,storyBuilder,universeBuilder,storyboards,decks,moodBoard,fableLoom,games,importer,authors,sharing}*',
      'server/lib/{story,storyboard,universe,fable,series,editorial,manuscript,deck,mood,pipeline,writers,rounds,bible}*',
      'server/lib/editorial/**',
      'server/services/{pipeline,rounds,writersRoom,storyBuilder,universe,storyboard,deck,mood,fableLoom,games,importer,authors,sharing,bible,series}*',
      'server/services/{pipeline,writersRoom,storyBuilderStore,universeBuilder,storyboards,moodBoard,fableLoom,games,importer,authors,sharing}/**',
      'client/src/pages/{Pipeline,Rounds,RoundEditor,RoundsGuide,WritersRoom,StoryBuilder,Storyboard,Universe,Deck,Mood,FableLoom,Game,Importer,Authors,Sharing,StartStory}*',
      'client/src/components/{pipeline,writers-room,storyBuilder,universe,universeBuilder,storyboards,decks,moodBoard,fableloom,games,sharing}/**',
    ],
  }),
  area({
    id: 'creative-director', label: 'Creative director',
    navPathPrefixes: ['/creative-director', '/creative-commission'],
    codeGlobs: [
      'server/routes/{creativeDirector,creativeCommissions}*',
      'server/lib/creative*',
      'server/services/creative*',
      'server/services/{creativeDirector,creativeCommissions,creative}/**',
      'client/src/pages/Creative*',
      'client/src/components/{creative-director,creative-commission,creative}/**',
      'client/src/lib/creative*',
    ],
  }),
  area({
    id: 'catalog', label: 'Catalog',
    navPathPrefixes: ['/catalog', '/casting'],
    codeGlobs: [
      'server/routes/catalog*',
      'server/lib/catalog/**',
      'server/lib/{catalog,cast,greybox}*',
      'server/services/catalog*/**',
      'server/lib/db/schema/catalog*',
      'client/src/pages/Catalog*',
      'client/src/components/{catalog,castIntegrity}/**',
      'client/src/components/CatalogCastPanel.jsx',
      'client/src/lib/{catalog,cast,greybox}*',
    ],
  }),
  area({
    id: 'music', label: 'Music',
    navPathPrefixes: ['/music', '/songbook'],
    codeGlobs: [
      'server/routes/music!(Video*)',
      'server/routes/{albums,artists,tracks,midiRuntime,superCollider}*',
      'server/lib/music!(Video*)',
      'server/lib/{song,midi,chiptune,suno,distrokid,beatGrid,lyric,wav,album,artist,track}*',
      'server/services/music!(Video*)',
      'server/services/{albums,artists,tracks,audioGen,chiptune,sunoShareLink,superCollider,track}*',
      'server/services/{albums,artists,audioGen,tracks}/**',
      'client/src/pages/Music!(Video*)',
      'client/src/pages/SongBook*',
      'client/src/components/{music,songbook,songs}/**',
      'client/src/lib/music!(Video*)',
      'client/src/lib/{song,drum,chord,piano,beat,wave,sing,chiptune,midi,metronome,pitch}*',
    ],
  }),
  area({
    id: 'brain', label: 'Brain', navSections: ['Brain'],
    codeGlobs: [
      'server/routes/{brain,memory,notes,feeds,rapidReader,spotify,youtube,timeline,search}*',
      'server/lib/brain*',
      'server/lib/{memory,spaced}*',
      'server/services/{brain,memory,feeds,rapidReader,spotify,youtube,ytdlp,thread,obsidian,localMemory,contextMemory,idealoom}*',
      'server/services/{brainStorage,memory}/**',
      'client/src/pages/{Brain,Wiki,Timeline,RapidReader}*',
      'client/src/components/{brain,notes,threads,timeline,wiki}/**',
      'client/src/components/{RapidReader,QuickBrainCapture,QuickIdeaCapture}*',
      'client/src/lib/{brain,rapid}*',
    ],
  }),
  area({
    id: 'tribe', label: 'Tribe',
    navPathPrefixes: ['/tribe'],
    codeGlobs: [
      'server/routes/tribe*',
      'server/lib/tribe*',
      'server/lib/db/schema/tribe.js',
      'server/services/tribe*',
      'client/src/pages/Tribe*',
      'client/src/components/tribe/!(BeeperIdentitiesPanel*)',
      'client/src/components/TribeCareWidget*',
      'client/src/lib/tribe*',
    ],
  }),
  area({
    id: 'calendar', label: 'Calendar', navSections: ['Calendar'],
    codeGlobs: [
      'server/routes/calendar*',
      'server/lib/calendar*',
      'server/services/calendar*',
      'client/src/pages/Calendar*',
      'client/src/components/calendar/**',
    ],
  }),
  area({
    id: 'digital-twin', label: 'Digital twin and identity', navSections: ['Identity', 'Goals'],
    codeGlobs: [
      'server/routes/{digital-twin,identity,character,avatar,ask,insights,privacy}*',
      'server/routes/digital-twin/**',
      'server/lib/{digital,persona,character,avatar,privacy,identity,insights,goal}*',
      'server/services/{digital-twin,twin,identity,character,avatar,ask,insights,privacy,goal,taste,timeCapsule}*',
      'server/services/{identity,layeredIntelligence}/**',
      'client/src/pages/{DigitalTwin,Character,Ask,Insights,Privacy,Goals}*',
      'client/src/components/digital-twin/!(tabs)',
      'client/src/components/digital-twin/tabs/!(Autobiography*)',
      'client/src/components/insights/!(GenomeHealthTab*)',
      'client/src/components/{persona,character,privacy,goals}/**',
    ],
  }),
  area({
    id: 'messages', label: 'Messages', navSections: ['Comms'],
    codeGlobs: [
      'server/routes/{messages,message,contacts,telegram}*',
      'server/lib/{message,telegram}*',
      'server/services/{message,contacts,telegram,gmail,discord,whatsapp}*',
      'client/src/pages/Messages*',
      'client/src/components/messages/!(Beeper*|IMessage*|Signal*|beeper)',
    ],
  }),
  area({
    id: 'cos', label: 'Chief of Staff', navSections: ['Chief of Staff'],
    navPathPrefixes: ['/review'],
    codeGlobs: [
      'server/routes/{cos,agent,featureAgents,runs,review,codeReview,humanActions}*',
      'server/lib/{cos,task,audit,autonomous,agent,reviewer,slashdo,claim,issue,release}*',
      'server/lib/{cos,agent,agentGuard}/**',
      'server/services/cos/**',
      'server/services/{taskLearning,taskPromptDefaults,autonomousJobs,agent,agentTuiSpawning,branchReconcile,worktree,scheduledHandlers,skills}/**',
      'server/services/{prDo,prProbe,prRemediation,prReviewer,prView,prWatcher}*',
      'server/services/{task,autonomous,branch,claim,review,worktree,merge,release,swarm,investigation,workItems,humanAction,deepAudit,auditFindings,perpetualWork}*',
      'client/src/pages/{ChiefOfStaff,Agents,AgentsPage,FeatureAgent,Review,PersistentMind}*',
      'client/src/components/cos/!(tabs)',
      'client/src/components/cos/tabs/!(Gsd*)',
      'client/src/components/cos/tabs/*/**',
      'client/src/components/{agents,feature-agents,review}/**',
      'client/src/lib/{cos,agent,reviewer}*',
    ],
  }),
  area({
    id: 'apps-devtools', label: 'Apps and developer tools',
    navSections: ['Dev Tools', 'Apps'], navPathPrefixes: ['/apps', '/templates'],
    codeGlobs: [
      'server/routes/{scaffold,git,github,history,loops,instances,dataManager,dataMaintenance,dataSync,referenceRepos,workspaceContexts,managed,apiDocs}*',
      'server/routes/apps/**',
      'server/services/{git,instances}/**',
      'server/services/app!(leHealth*)',
      'server/services/{git,forge,repo,pm2,loops,instances,dataManager,managed,xcode,workspaceContext}*',
      'server/lib/app!(leHealth*)',
      'server/lib/{git,forge,repo,scaffold}*',
      'server/lib/{prDisposition,prHandbackPolicy,prReview}*',
      'client/src/pages/{Apps,AppDetail,CreateApp,GitHub,History,Loops,Instances,DataManager,Runner,Processes,Workspace,ApiExplorer,Ambient,Security}*',
      'client/src/components/apps/!(JiraConfigPanel*|tabs)',
      'client/src/components/apps/tabs/!(Datadog*|Gsd*|Jira*)',
      'client/src/components/apps/tabs/*/**',
      'client/src/components/{github,instances,dataManager}/**',
    ],
  }),
  area({
    id: 'models-ai', label: 'Models and AI providers', navSections: ['Models'],
    navPathPrefixes: ['/ai'],
    codeGlobs: [
      'server/routes/{providers,provider,harnesses,model,lmstudio,localLlm,quotaBurn,usage,moaPresets}*',
      'server/routes/{providers,localLlm}/**',
      'server/lib/local!(Memory*)',
      'server/lib/{provider,model,quota,usage,codex,llm,ollama,vllm,sglang,mtplx,slotstream,subscription,aiToolkit}*',
      'server/lib/{aiToolkit,provider}/**',
      'server/services/{provider,aiProvider,ai,harness,model,ollama,lmStudio,llama,vllm,sglang,mtplx,slotstream,quota,usage,codex,claude,subscription,embeddings,fleet,moa}*',
      'server/services/local!(Memory*)',
      'server/services/{ollama,provider,quotaBurn}/**',
      'client/src/pages/{Models,AIProviders,Local,Quota,Usage}*',
      'client/src/components/models/!(Jev*|LayaMlx*)',
      'client/src/components/{providers,localLlm,quotaBurn,usage}/**',
      'client/src/{lib,hooks}/{local,quota,usage,provider}*',
    ],
  }),
  area({
    id: 'voice', label: 'Voice',
    navPathPrefixes: ['/settings/voice'],
    codeGlobs: [
      'server/routes/voice*',
      'server/lib/{voice,speech}*',
      'server/services/voice/!(facetimeBridge*)',
      'server/services/voice/*/**',
      'server/sockets/voice*',
      'client/src/pages/Voice!(CallHost*)',
      'client/src/components/voice/**',
      'client/src/services/voice*',
    ],
  }),
  area({
    id: 'browser', label: 'PortOS Browser',
    navPathPrefixes: ['/browser'],
    codeGlobs: [
      'server/routes/browser*',
      'server/services/browser*',
      'client/src/pages/Browser*',
    ],
  }),
  area({
    id: 'shell', label: 'Shell',
    navPathPrefixes: ['/shell'],
    codeGlobs: [
      'server/routes/shell*',
      'server/lib/shell*',
      'server/services/shell*',
      'server/sockets/shell*',
      'client/src/pages/Shell*',
      'client/src/components/shell/!(Iterm*|useItermSession*)',
    ],
  }),
  area({
    id: 'settings-core', label: 'Settings and platform', navSections: ['Settings'],
    codeGlobs: [
      'server/routes/auth!(ors*)',
      'server/routes/{settings,backup,database,capabilities,update,network,ports,platform,notifications}*',
      'server/lib/{backup,database,pg,settings,credential,security,secret,update,ports,instance}*',
      'server/lib/databaseMaintenance/**',
      'server/lib/db/extensions.js',
      'server/lib/db/schema/{core,index,syncFeed}.*',
      'server/services/auth!(ors*)',
      'server/services/{settings,backup,database,db,cert,credential,update,instanceFeatures,instanceIdentity,bootstrap,boot,software,autoUpdate,ports}*',
      'server/services/backup/**',
      'server/services/bootstrap/**',
      'client/src/pages/{Settings,Login,Capability,SystemHealth}*',
      'client/src/components/settings/!(DockerContainment*|Rigging*|MortalLoom*|voice)',
      'client/src/components/settings/{assessments,library}/**',
    ],
  }),
]);

const AREA_BY_ID = new Map(FEATURE_AREAS.map((entry) => [entry.id, entry]));
const AREA_BY_INSTANCE_FEATURE = new Map(FEATURE_AREAS.filter((entry) => entry.instanceFeatureId).map((entry) => [entry.instanceFeatureId, entry]));
const AREA_BY_SECTION = new Map(FEATURE_AREAS.flatMap((entry) => entry.navSections.map((section) => [section, entry])));
// Longest prefix first, so `/shell/iterm` outranks `/shell` and a drill-down never lands on its parent's area.
const PREFIX_OWNERS = FEATURE_AREAS
  .flatMap((entry) => entry.navPathPrefixes.map((prefix) => ({ prefix, entry })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

export const getFeatureArea = (id) => AREA_BY_ID.get(id) ?? null;
export const isOptionalFeatureArea = (entry) => Boolean(entry?.instanceFeatureId);

const barePath = (pathname) => {
  const bare = String(pathname ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
  return bare || '/';
};

export function areaForNavPath(pathname) {
  const path = barePath(pathname);
  const prefixed = PREFIX_OWNERS.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`));
  if (prefixed) return prefixed.entry;
  const command = getNavCommandForPath(path);
  if (!command) return null;
  return AREA_BY_INSTANCE_FEATURE.get(command.feature) ?? AREA_BY_SECTION.get(command.section) ?? null;
}

// path.posix.matchesGlob recompiles its pattern on every call, so matching every glob against a 14k-file tree is
// seconds of work. Expanding braces up front and bucketing each pattern by its literal directory prefix lets a file
// consult only the patterns whose directory is one of its own ancestors.
function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  const parts = [];
  let start = open + 1;
  for (let index = open; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '{') depth += 1;
    else if (char === '}' || (char === ',' && depth === 1)) {
      if (char === '}') depth -= 1;
      if (char === ',' || depth === 0) {
        parts.push(glob.slice(start, index));
        start = index + 1;
      }
      if (depth === 0) return parts.flatMap((part) => expandBraces(`${glob.slice(0, open)}${part}${glob.slice(index + 1)}`));
    }
  }
  throw new Error(`Unbalanced braces in feature area glob: ${glob}`);
}

// The directory part of a glob before its first wildcard, with the trailing slash ('' when the glob starts with one).
const literalPrefix = (glob) => {
  const magic = glob.search(/[*?[\]()!]/);
  const literal = magic === -1 ? glob : glob.slice(0, magic);
  return literal.slice(0, literal.lastIndexOf('/') + 1);
};

/** Brace-free patterns for one catalog glob, each with the literal directory prefix a matching file must start with. */
export const expandCodeGlob = (glob) => expandBraces(glob).map((pattern) => ({ glob: pattern, prefix: literalPrefix(pattern) }));

// matchesGlob recompiles its pattern on every call, so a few hundred wildcard globs times a 14k-file tree dominated the
// cost. Globs built only from literal characters, `*`, `?` and a trailing `/**` compile once to an equivalent RegExp
// (minimatch rules: a wildcard never matches a leading dot or crosses a slash; `**` skips dot-segments). Anything else
// (brackets, extglobs, a mid-path `**`) keeps using matchesGlob, and featureAreaCatalog.test.js pins the equivalence.
const SIMPLE_SEGMENT = /^[A-Za-z0-9_.*?-]+$/;
const segmentSource = (segment) => {
  const body = [...segment].map((char) => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char === '.' ? '\\.' : char)).join('');
  return /^[*?]/.test(segment) ? '(?!\\.)' + body : body;
};
// Node's matchesGlob folds case on Windows and macOS; mirror it so the fast path never disagrees with the fallback.
const GLOB_FLAGS = process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '';
const compileCodeGlob = (glob) => {
  const deep = glob.endsWith('/**');
  const segments = (deep ? glob.slice(0, -3) : glob).split('/');
  if (!segments.every((segment) => SIMPLE_SEGMENT.test(segment) && !segment.includes('**'))) return null;
  const tail = deep ? '/(?:(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*/?)?' : '';
  return new RegExp('^' + segments.map(segmentSource).join('/') + tail + '$', GLOB_FLAGS);
};

const REGEX_BY_GLOB = new Map();
export const matchesCodeGlob = (file, glob) => {
  if (!REGEX_BY_GLOB.has(glob)) REGEX_BY_GLOB.set(glob, compileCodeGlob(glob));
  const regex = REGEX_BY_GLOB.get(glob);
  return regex ? regex.test(file) : posix.matchesGlob(file, glob);
};

const PATTERNS_BY_PREFIX = new Map();
for (const entry of FEATURE_AREAS) {
  for (const codeGlob of entry.codeGlobs) {
    for (const { glob, prefix } of expandCodeGlob(codeGlob)) {
      if (!PATTERNS_BY_PREFIX.has(prefix)) PATTERNS_BY_PREFIX.set(prefix, []);
      PATTERNS_BY_PREFIX.get(prefix).push({ entry, glob });
    }
  }
}

const ancestorPrefixes = (file) => {
  const prefixes = [''];
  for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) prefixes.push(file.slice(0, slash + 1));
  return prefixes;
};

export function areasForFile(repoRelativePath) {
  const file = String(repoRelativePath ?? '').replaceAll('\\', '/');
  const owners = new Set();
  for (const prefix of ancestorPrefixes(file)) {
    for (const { entry, glob } of PATTERNS_BY_PREFIX.get(prefix) ?? []) {
      if (!owners.has(entry) && matchesCodeGlob(file, glob)) owners.add(entry);
    }
  }
  return FEATURE_AREAS.filter((entry) => owners.has(entry));
}
