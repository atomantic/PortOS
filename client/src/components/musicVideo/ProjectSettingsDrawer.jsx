import { Bot, FolderOpen, Music, SlidersHorizontal } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import ProjectOptionsPanel from './ProjectOptionsPanel.jsx';
import SongRevisionPanel from './SongRevisionPanel.jsx';
import { AdvancedTrackControls } from './TrackPanel.jsx';
import AudioTimingPanel from './AudioTimingPanel.jsx';
import { MidiAction } from './ProjectActionGroups.jsx';
import AutonomousRunPanel from './AutonomousRunPanel.jsx';
import AutopilotPanel from './AutopilotPanel.jsx';
import DevArtifactsPanel from './DevArtifactsPanel.jsx';
import HandoffControls from './HandoffControls.jsx';
import MakingOfExportPanel from './MakingOfExportPanel.jsx';

const SETTINGS_TABS = [
  { id: 'project', label: 'Project', icon: SlidersHorizontal },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'autopilot', label: 'Autopilot', icon: Bot },
  { id: 'files', label: 'Files', icon: FolderOpen },
];
export const SETTINGS_TAB_IDS = SETTINGS_TABS.map((tab) => tab.id);

/**
 * Everything that configures the project rather than moving it forward — kept
 * out of the six steps so each step shows only its own work: the render style,
 * media and services (Project), song forks, stems, MIDI and timing revisions
 * (Audio), the automation brief, production runs and the autonomous run log
 * (Autopilot), and every development file, the external handoff and the
 * making-of export (Files). `tab` is the open tab, held in the page URL.
 */
export default function ProjectSettingsDrawer({ open, tab, onTabChange, onClose, board }) {
  if (!board) return null;
  const { project, locked, tracks, renderBound, midiBound, separation, midi, takes } = board;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Project settings"
      subtitle={project.name}
      size="lg"
      tabs={SETTINGS_TABS}
      activeTab={tab}
      onTabChange={onTabChange}
      closeLabel="Close project settings"
    >
      {tab === 'project' && (
        <ProjectOptionsPanel
          project={project}
          videoSettings={board.videoSettings}
          generatingVideos={Object.keys(board.sceneMedia?.genVideoScenes || {}).length > 0}
          onMediaMode={board.saveMediaMode}
          onRenderStyle={board.onRenderStyle}
          onSaveAutomation={board.saveAutomation}
          onSavePolicy={(productionPolicy) => board.saveCreativeSetup({ productionPolicy })}
        />
      )}
      {tab === 'audio' && (
        <div className="space-y-3">
          <SongRevisionPanel key={`song-${project.id}`} project={project} tracks={tracks} onUpdated={board.replaceProject} onFork={board.onForkSong} disabled={locked || renderBound || midiBound} />
          <fieldset disabled={locked} className="min-w-0 space-y-2">
            <AdvancedTrackControls project={project} tracks={tracks} renderBound={renderBound} onProjectUpdated={board.replaceProject} separation={separation} />
            <MidiAction project={project} midi={midi} midiBound={midiBound} />
          </fieldset>
          <AudioTimingPanel key={`timing-${project.id}`} project={project} tracks={tracks} onApplied={board.replaceProject} disabled={locked || renderBound} />
        </div>
      )}
      {tab === 'autopilot' && (
        <div className="space-y-3">
          {board.autopilotRun && (
            <AutonomousRunPanel
              key={`autonomous-${project.id}`}
              project={project}
              auto={board.autonomous}
              readiness={board.productionReadiness}
              selectedStage={board.runStage}
              onSelectStage={board.onSelectStage}
              framed
            />
          )}
          <fieldset disabled={locked} className="min-w-0">
            <AutopilotPanel
              key={`autopilot-${project.id}`}
              project={project}
              production={board.production}
              readiness={board.productionReadiness}
              onSave={board.saveAutomation}
              onKickoff={board.onKickoff}
              onCancelKickoff={board.kickoff.running ? board.kickoff.cancel : undefined}
              kickoffBusy={board.busy.analyzing || board.busy.planning || board.kickoff.running}
              kickoffStep={board.kickoff.stepLabel}
              kickoffBlockedReason={board.autopilotBlockedReason}
            />
          </fieldset>
        </div>
      )}
      {tab === 'files' && (
        <div className="space-y-3">
          <div id="mv-review-development">
            <DevArtifactsPanel project={project} busy={board.devArtifacts.busy} onOpen={board.openArtifact} onUpload={board.onUploadArtifact} />
          </div>
          <section aria-label="External handoff" className="space-y-2">
            <h3 className="text-sm font-medium">External handoff</h3>
            <HandoffControls
              projectId={project.id}
              busy={takes.busy}
              onExport={takes.exportHandoff}
              onExportBundle={takes.exportHandoffBundle}
              onImport={takes.importHandoffFiles}
            />
          </section>
          <section aria-label="Making-of export" className="space-y-2">
            <h3 className="text-sm font-medium">Making-of export</h3>
            <MakingOfExportPanel project={project} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
