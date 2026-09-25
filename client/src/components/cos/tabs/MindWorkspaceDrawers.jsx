import { Check, CirclePlay, StickyNote, Upload } from 'lucide-react';
import Drawer from '../../Drawer';
import TabPills from '../../ui/TabPills';
import PersistentMindContextPanel from '../PersistentMindContextPanel';
import PersistentMindJournalPanel from '../PersistentMindJournalPanel';
import PersistentMindMaintenancePanel from '../PersistentMindMaintenancePanel';
import PersistentMindPortabilityPanel from '../PersistentMindPortabilityPanel';
import PersistentMindProfileControls from '../PersistentMindProfileControls';
import PersistentMindRuntimePanel from '../PersistentMindRuntimePanel';
import PersistentMindSessions from '../PersistentMindSessions';
import PersistentMindThinkingRequests from '../PersistentMindThinkingRequests';
import PersistentMindThinkingPresets from '../PersistentMindThinkingPresets';
import PersistentMindVisibilityPanel from '../PersistentMindVisibilityPanel';
import PersistentMindTools from '../../../pages/PersistentMindTools';
import { formatDateTime } from '../../../utils/formatters';
import { ActionButton, eventLabel, eventText, MIND_PANEL_TABS, MessageImages, safeMessageImages } from './MindPanelParts.jsx';

export default function MindWorkspaceDrawers({
  activePanel,
  closePanel,
  visitedPanels,
  openPanel,
  runtime,
  runtimeError,
  runtimeLoading,
  visibility,
  visibilityError,
  visibilityLoading,
  loadVisibility,
  prepareRepair,
  contextRefreshKey,
  refreshContext,
  mind,
  handleMindspaceCleaned,
  updateCapabilities,
  setCapabilitiesSaving,
  thinkingPresets,
  editingPresetId,
  setMindParam,
  setPresetsSaving,
  saveThinkingRequests,
  cancelThinkingRequest,
  saveThinkingPresets,
  turnExecutions,
  providers,
  selectedTurnId,
  setProfileSaving,
  saveProfile,
  state,
  setupSaving,
  profileReady,
  lifecyclePending,
  loading,
  runLifecycle,
  selectedEventId,
  closeSelectedEvent,
  selectedEvent,
  eventActionPending,
  acknowledge,
  promote,
  submitAnnotation,
  annotationText,
  changeAnnotationText,
  annotationError,
  annotationSubmitting,
}) {
  return (
    <>
      <Drawer
        open={Boolean(activePanel)}
        onClose={closePanel}
        title="Mind workspace"
        subtitle="Inspect and configure the state available to Persistent Mind"
        size="xl"
        closeLabel="Close mind workspace"
        closeOnEsc={false}
        closeOnBackdrop={false}
      >
        <div className="mb-4">
          <TabPills tabs={MIND_PANEL_TABS} activeTab={activePanel || 'context'} onChange={openPanel} variant="pills" size="sm" mobileCompact ariaLabel="Mind workspace sections" />
        </div>
        {(visitedPanels.has('context') || activePanel === 'context') && <div hidden={activePanel !== 'context'} className="space-y-4">
          <PersistentMindRuntimePanel runtime={runtime} error={runtimeError} loading={runtimeLoading} />
            <PersistentMindVisibilityPanel visibility={visibility} error={visibilityError} loading={visibilityLoading} onRefresh={() => loadVisibility({ refresh: true })} onPrepareRepair={prepareRepair} />
          <PersistentMindContextPanel view="context" refreshKey={contextRefreshKey} />
        </div>}
        {(visitedPanels.has('journal') || activePanel === 'journal') && <div hidden={activePanel !== 'journal'}>
          <PersistentMindJournalPanel refreshKey={contextRefreshKey} />
        </div>}
        {(visitedPanels.has('memories') || activePanel === 'memories') && <div hidden={activePanel !== 'memories'}>
            <PersistentMindContextPanel view="memories" refreshKey={contextRefreshKey} onMemoriesChanged={refreshContext} />
        </div>}
        {(visitedPanels.has('maintenance') || activePanel === 'maintenance') && <div hidden={activePanel !== 'maintenance'}>
          <PersistentMindMaintenancePanel
            selfCleanupEnabled={mind?.capabilities?.manageMind === true}
            onOpenTools={() => openPanel('tools')}
            onCleaned={handleMindspaceCleaned}
          />
        </div>}
        {(visitedPanels.has('tools') || activePanel === 'tools') && <div hidden={activePanel !== 'tools'}>
            <PersistentMindTools onCapabilitiesChange={updateCapabilities} onSavingChange={setCapabilitiesSaving} />
        </div>}
        {(visitedPanels.has('models') || activePanel === 'models') && <div hidden={activePanel !== 'models'} className="space-y-6">
          <PersistentMindThinkingRequests
            catalog={mind?.thinkingRequests}
            capabilities={mind?.capabilities}
              onSaved={saveThinkingRequests}
              onCancelled={cancelThinkingRequest}
          />
          <PersistentMindThinkingPresets
            presets={thinkingPresets}
            disabled={!mind}
            editingPresetId={editingPresetId}
            onEditPreset={(id) => setMindParam('presetEdit', id)}
              onSaved={saveThinkingPresets}
            onSavingChange={setPresetsSaving}
          />
          <PersistentMindSessions
            turnExecutions={turnExecutions}
            providers={providers}
            selectedTurnId={selectedTurnId}
            onSelectTurn={(turnId) => setMindParam('turn', turnId)}
          />
        </div>}
        {(visitedPanels.has('settings') || activePanel === 'settings') && <section hidden={activePanel !== 'settings'} aria-labelledby="mind-profile-heading" className="rounded border border-port-border bg-port-card p-4">
          <div className="mb-3">
            <h3 id="mind-profile-heading" className="text-sm font-semibold text-port-text">AI profile</h3>
            <p className="mt-1 text-xs text-port-text-muted">Pin the provider, model, effort, and wake cadence. Changes apply to the next wake and never silently fall back to another model.</p>
          </div>
          <PersistentMindProfileControls
            profile={mind?.profile}
            disabled={!mind}
              onSaved={saveProfile}
            onSavingChange={setProfileSaving}
          />
          <div className="mt-6 border-t border-port-border pt-4">
            <h3 className="text-sm font-semibold text-port-text">Portability</h3>
            <p className="mt-1 mb-3 text-xs text-port-text-muted">Carry this Mind to another PortOS install as one encrypted file you download and keep.</p>
            <PersistentMindPortabilityPanel />
          </div>
          {!state?.started && (
            <div className="mt-4 flex flex-col gap-2 border-t border-port-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-port-text-muted">{setupSaving ? 'Saving persistent mind settings…' : profileReady ? 'The saved AI profile is ready.' : 'Enable the profile and select both an AI provider and model to start.'}</p>
              <ActionButton label="Start persistent mind" icon={CirclePlay} pending={lifecyclePending === 'start'} disabled={loading || setupSaving || !profileReady} onClick={() => runLifecycle('start')} />
            </div>
          )}
        </section>}
      </Drawer>

      <Drawer
        open={Boolean(selectedEventId)}
        onClose={closeSelectedEvent}
        title={selectedEvent ? eventLabel(selectedEvent.kind) : 'Event details'}
        subtitle={selectedEvent?.at ? formatDateTime(selectedEvent.at) : undefined}
        size="sm"
        closeLabel="Close event details"
      >
        {selectedEvent ? (
          <div className="space-y-5">
            <section aria-labelledby="mind-event-content-heading">
              <h3 id="mind-event-content-heading" className="text-xs font-semibold uppercase tracking-wide text-port-accent">Message</h3>
              {eventText(selectedEvent) && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-port-text">{eventText(selectedEvent)}</p>}
              <MessageImages images={safeMessageImages(selectedEvent)} />
              {!eventText(selectedEvent) && safeMessageImages(selectedEvent).length === 0 && <p className="mt-2 text-sm text-port-text">{selectedEvent.kind}</p>}
            </section>

            <section aria-labelledby="mind-event-metadata-heading" className="space-y-2 border-t border-port-border pt-4">
              <h3 id="mind-event-metadata-heading" className="text-xs font-semibold uppercase tracking-wide text-port-accent">Event metadata</h3>
              <p className="break-all font-mono text-xs text-port-text-muted">{selectedEvent.eventId}</p>
              <p className="text-xs text-port-text-muted">Sequence {selectedEvent.sequence}{selectedEvent.turnId ? ` · turn ${selectedEvent.turnId}` : ''}</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-port-border bg-port-bg p-3 text-[11px] text-port-text-muted">{JSON.stringify(selectedEvent.data || {}, null, 2)}</pre>
            </section>

            <div className="flex flex-wrap gap-2 border-t border-port-border pt-4">
              {selectedEvent.kind === 'mind.capability.request' && <ActionButton label="Acknowledge" icon={Check} pending={eventActionPending === selectedEvent.eventId} onClick={() => acknowledge(selectedEvent)} />}
              {['mind.summary', 'mind.reply', 'mind.thought', 'mind.memory.candidate'].includes(selectedEvent.kind) && (
                <ActionButton label="Promote to memory" icon={Upload} pending={eventActionPending === selectedEvent.eventId} disabled={!eventText(selectedEvent)} onClick={() => promote(selectedEvent)} />
              )}
            </div>

            <form onSubmit={submitAnnotation} className="space-y-3 border-t border-port-border pt-4">
              <div>
                <label htmlFor="mind-annotation-text" className="flex items-center gap-2 text-sm font-medium text-port-text"><StickyNote size={15} aria-hidden="true" /> Add a note</label>
                <p className="mt-1 text-xs text-port-text-muted">Attach context to this event without starting a new turn.</p>
              </div>
              <textarea id="mind-annotation-text" value={annotationText} onChange={(event) => changeAnnotationText(event.target.value)} maxLength={8000} rows={4} className="w-full resize-y rounded-xl border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text focus:border-port-accent focus:outline-none" placeholder="Add context or an idea…" />
              {annotationError && <p role="alert" className="text-sm text-port-error">{annotationError} — Retry uses the same id.</p>}
              <button type="submit" disabled={!annotationText.trim() || annotationSubmitting} className="rounded-full bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{annotationSubmitting ? 'Adding note…' : annotationError ? 'Retry note' : 'Add note'}</button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-port-text-muted">This event is no longer available in the retained conversation history.</p>
        )}
      </Drawer>
    </>
  );
}
