import Drawer from '../Drawer';
import { ImageGenTab } from '../settings/ImageGenTab';
import MediaPreview from '../media/MediaPreview';
import GalleryImagePicker from './GalleryImagePicker';
import RuntimeRemedyModals from './RuntimeRemedyModals';

export default function ImageGenOverlays({ preview, galleryPicker, settings, runtimeInstall }) {
  return (
    <>
      <MediaPreview
        preview={preview.value}
        setPreview={preview.set}
        items={preview.items}
        annotations={preview.annotations}
        updateAnnotation={preview.updateAnnotation}
        onPromptSaved={preview.onPromptSaved}
        onRemix={preview.onRemix}
        onSendToImage={preview.onSendToImage}
        onSendToVideo={preview.onSendToVideo}
        onSendTo3d={preview.onSendTo3d}
        onClean={preview.onClean}
        onRegenerate={preview.onRegenerate}
        onRemoveWatermark={preview.onRemoveWatermark}
        regenAvailable={preview.regenAvailable}
        regenBounds={preview.regenBounds}
      />
      <GalleryImagePicker open={!!galleryPicker.value} onClose={galleryPicker.onClose} onSelect={galleryPicker.onSelect} />
      <Drawer open={settings.open} onClose={settings.onClose} title="Media Generation Settings" size="lg">
        <ImageGenTab />
      </Drawer>
      <RuntimeRemedyModals kind={runtimeInstall.kind} modelId={runtimeInstall.modelId} onClose={runtimeInstall.onClose} onComplete={runtimeInstall.onComplete} />
    </>
  );
}
