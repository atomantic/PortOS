import Drawer from '../Drawer';
import { ImageGenTab } from '../settings/ImageGenTab';
import MediaPreview from '../media/MediaPreview';
import GalleryImagePicker from './GalleryImagePicker';
import Flux2InstallModal from './Flux2InstallModal';

export default function ImageGenOverlays({ preview, galleryPicker, settings, flux2 }) {
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
      <Flux2InstallModal open={flux2.open} onClose={flux2.onClose} onComplete={flux2.onComplete} modelId={flux2.modelId} />
    </>
  );
}
