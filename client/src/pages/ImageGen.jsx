import MediaJobsQueue from '../components/media/MediaJobsQueue';
import ImageGenGallerySections from '../components/imageGen/ImageGenGallerySections';
import ImageGenHeader from '../components/imageGen/ImageGenHeader';
import ImageGenOverlays from '../components/imageGen/ImageGenOverlays';
import ImageGenWorkspace from '../components/imageGen/ImageGenWorkspace';
import { useImageGenPageRuntime } from '../hooks/useImageGenPageRuntime';

export default function ImageGen() {
  const {
    form,
    backend,
    generation,
    gallery,
    header,
    settings,
    flux2,
  } = useImageGenPageRuntime();

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <ImageGenHeader
        status={header.status}
        backends={header.backends}
        remix={header.remix}
        actions={header.actions}
      />
      <ImageGenWorkspace
        form={form}
        backend={backend}
        generation={generation}
        onSendToVideo={gallery.cards.sendToVideo}
      />
      <MediaJobsQueue kind="image" />
      <ImageGenGallerySections gallery={gallery.view} cards={gallery.cards} />
      <ImageGenOverlays
        preview={gallery.overlay}
        galleryPicker={gallery.picker}
        settings={settings}
        flux2={flux2}
      />
    </div>
  );
}
