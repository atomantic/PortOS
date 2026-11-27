import { Suspense } from 'react';
import ProjectManageActions from './ProjectManageActions.jsx';
import { lazyWithReload } from '../../utils/lazyWithReload.js';

const ContactSheetDrawer = lazyWithReload(() => import('./ContactSheetDrawer.jsx'));
const DevArtifactDrawer = lazyWithReload(() => import('./DevArtifactDrawer.jsx'));
const ProjectSettingsDrawer = lazyWithReload(() => import('./ProjectSettingsDrawer.jsx'));
const GalleryImagePicker = lazyWithReload(() => import('../imageGen/GalleryImagePicker.jsx'));
const GalleryVideoPicker = lazyWithReload(() => import('../videoGen/GalleryVideoPicker.jsx'));

export default function WorkspaceDrawers({
  selected, navigation, board, castSetsStage, produce, plan, pickerTarget, setPickerTarget,
  openPreview, cloning, onClone, deletion,
}) {
  const { contactSheetOpen, setContactSheetOpen, contactSheetPendingOnly, setContactSheetPendingOnly, routeArtifactId,
    closeArtifact, openArtifactRecord, artifactVersion, setArtifactVersion, settingsTab, setSettingsTab } = navigation;
  const { castSets, devArtifacts } = castSetsStage;
  const { takes, sceneMedia } = produce;
  const handlePickerSelect = (item) => {
    if (!item?.filename || !pickerTarget || !selected) return;
    if (pickerTarget.type === 'reference') {
      const references = selected.visualSpec?.references || [];
      if (references.some((ref) => ref.imageId === item.filename)) return;
      castSetsStage.saveVisualSpec({ references: [...references, { imageId: item.filename, role: 'mood', condition: false }] });
      return;
    }
    const scene = (selected.scenes || []).find((s) => s.sceneId === pickerTarget.sceneId);
    if (scene) takes.importTake(scene, item);
  };
  // Per-scene "Import clip take" (#8978) — pick an existing video-history
  // clip and add it as a take, mirroring handlePickerSelect's image path.
  const handleClipPickerSelect = (item) => {
    if (!item?.id || !pickerTarget || pickerTarget.type !== 'clip' || !selected) return;
    const scene = (selected.scenes || []).find((s) => s.sceneId === pickerTarget.sceneId);
    if (scene) takes.importClipTake(scene, item);
  };
  return (
    <>
      <Suspense fallback={null}>
      {pickerTarget && pickerTarget.type !== 'clip' && (
        <GalleryImagePicker
          open
          allowUpload
          onClose={() => setPickerTarget(null)}
          onSelect={handlePickerSelect}
        />
      )}
      {pickerTarget && pickerTarget.type === 'clip' && (
        <GalleryVideoPicker
          open
          onClose={() => setPickerTarget(null)}
          onSelect={handleClipPickerSelect}
          allowUpload
          uploadToGallery
        />
      )}
      {routeArtifactId && <DevArtifactDrawer
          key={routeArtifactId || 'none'}
          open={!!routeArtifactId}
          onClose={closeArtifact}
          project={selected}
          artifact={openArtifactRecord}
          version={artifactVersion}
          onVersionChange={setArtifactVersion}
          ops={devArtifacts}
          busy={devArtifacts.busy || castSets.busy}
          castAndSets={{ regenerate: () => castSets.regenerate(), approveAndContinue: plan.approveCastAndSets }}
        />}
      {contactSheetOpen && <ContactSheetDrawer
          open={contactSheetOpen}
          onClose={() => setContactSheetOpen(false)}
          project={selected}
          busy={takes.busy}
          saving={takes.pending}
          onSelectTake={takes.selectTake}
          onReviewTake={takes.reviewTake}
          onMoveTake={takes.moveTake}
          onOpenPreview={openPreview}
          pendingOnly={contactSheetPendingOnly}
          onPendingOnlyChange={setContactSheetPendingOnly}
          onRegenerateFrame={sceneMedia.generateFrame}
          generatingScenes={sceneMedia.genScenes}
        />}
      </Suspense>
      {settingsTab && <Suspense fallback={null}><ProjectSettingsDrawer open={!!settingsTab} tab={settingsTab || 'project'} onTabChange={setSettingsTab} onClose={() => setSettingsTab(null)}
            board={board}
            manageActions={(
              <ProjectManageActions
                project={selected}
                cloning={cloning}
                onFork={(options) => onClone(options)}
                confirmingDelete={deletion.isConfirming(selected.id)}
                onDeleteRequest={() => deletion.request(selected.id)}
                onDeleteConfirm={() => deletion.confirm(selected.id)}
                onDeleteCancel={deletion.cancel}
              />
            )}
          /></Suspense>}
    </>
  );
}
