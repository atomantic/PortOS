import { Film, GitBranch, Image as ImageIcon, Music, SlidersHorizontal, Type } from 'lucide-react';
import { GEMINI_OMNI_WEB_MODEL } from '../../../../server/lib/geminiWebVideo.js';
import { IC_LORA_MODES } from '../../lib/videoGenParams.js';

const MODES = [
  { id: 'text',   label: 'Text',   icon: Type,       desc: 'Text-to-video' },
  { id: 'image',  label: 'Image',  icon: ImageIcon,  desc: 'Image-to-video (start frame)' },
  { id: 'fflf',   label: 'FFLF',   icon: GitBranch,  desc: 'First frame + last frame' },
  { id: 'extend', label: 'Extend', icon: Film,       desc: 'Continue from a prior render' },
  { id: 'a2v',    label: 'Audio',  icon: Music,      desc: 'Audio-to-video (audio drives motion + sync)' },
  // IC-LoRA remix modes (issue #3100) — derived from the registry so a new
  // remix mode appears in the mode bar automatically.
  ...IC_LORA_MODES.map((m) => ({ id: m.mode, label: m.label, icon: SlidersHorizontal, desc: m.description })),
];

const BACKEND_TITLES = {
  grok: 'Render via the Grok Build CLI (image_gen → image_to_video). Counts against your Grok plan.',
  fal: 'Render via the fal.ai queue API. Counts against your fal.ai balance.',
  reactor: 'Render via the reactor.inc fast-h3 API. Counts against your reactor.inc balance.',
  runway: 'Render from text or animate a start frame via the Runway API. Counts against your Runway credits.',
  gemini: 'Render through the Gemini web app in the PortOS Browser. Counts against the signed-in Google account.',
  higgsfield: 'Render Seedance, Kling or Wan via the Higgsfield API. Billed to your Higgsfield account.',
  google: 'Render Veo through your Google Cloud Agent Platform project. Billed to your Google Cloud account.',
  local: 'Render on this machine with the local runtimes.',
};

/**
 * Backend switch — shown only when the user enabled Grok in Settings → Image
 * Gen and/or configured a hosted provider. Every cloud backend's
 * image-to-video only supports text (image-first) and image modes, so
 * switching to one snaps an unsupported mode back to the nearest one.
 * `laneEnabled` maps each hosted lane id to whether it is usable here.
 */
export function VideoGenBackendSwitch({ laneEnabled, backend, onBackendChange }) {
  if (!Object.values(laneEnabled).some(Boolean)) return null;
  const lanes = [
    { id: 'local', label: 'Local' },
    ...(laneEnabled.grok ? [{ id: 'grok', label: 'Grok' }] : []),
    ...(laneEnabled.fal ? [{ id: 'fal', label: 'fal.ai' }] : []),
    ...(laneEnabled.reactor ? [{ id: 'reactor', label: 'Reactor.inc' }] : []),
    ...(laneEnabled.runway ? [{ id: 'runway', label: 'Runway' }] : []),
    ...(laneEnabled.gemini ? [{ id: 'gemini', label: GEMINI_OMNI_WEB_MODEL.label }] : []),
    ...(laneEnabled.higgsfield ? [{ id: 'higgsfield', label: 'Higgsfield' }] : []),
    ...(laneEnabled.google ? [{ id: 'google', label: 'Google' }] : []),
  ];
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-1 flex flex-wrap gap-1" role="group" aria-label="Video generation backend">
      {lanes.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={backend === id}
          onClick={() => onBackendChange(id)}
          className={`flex-auto whitespace-nowrap px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            backend === id ? 'bg-port-accent text-white shadow' : 'text-gray-400 hover:text-white hover:bg-port-border/40'
          }`}
          title={BACKEND_TITLES[id]}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Mode switch — segmented control above the form. Sets state that both the
 * form rendering and the submit payload react to. Implemented as plain toggle
 * buttons with `aria-pressed` rather than WAI-ARIA Tabs, since the
 * mode-specific inputs aren't structured as tabpanels and we don't implement
 * roving-tabindex/arrow-key focus. A hosted lane offers only Text and Image;
 * Runway adds its two special video modes.
 */
export function VideoGenModeSwitch({ mode, isRunway, rendersOffMachine, onSelectMode }) {
  const modes = isRunway
    ? [...MODES.filter((m) => m.id === 'text' || m.id === 'image'),
      { id: 'video-edit', label: 'Video edit', icon: SlidersHorizontal, desc: 'Edit a source video with Aleph 2' },
      { id: 'character-performance', label: 'Character performance', icon: SlidersHorizontal, desc: 'Apply a performance to a character with Act-Two' }]
    : rendersOffMachine ? MODES.filter((m) => m.id === 'text' || m.id === 'image') : MODES;
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-1 flex flex-wrap gap-1" role="group" aria-label="Video generation mode">
      {modes.map(({ id, label, icon: Icon, desc }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelectMode(id)}
            className={`flex-1 min-w-[120px] flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
              active
                ? 'bg-port-accent text-white shadow'
                : 'text-gray-400 hover:text-white hover:bg-port-border/40'
            }`}
            title={desc}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
