import ImageGenFormEditor from './ImageGenFormEditor';
import ImageGenPreview from './ImageGenPreview';

export default function ImageGenWorkspace({ form, backend, generation, onSendToVideo }) {
  return (
    <form onSubmit={generation.handleGenerate} className="grid min-w-0 max-w-full grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
      <ImageGenFormEditor form={form} backend={backend} generation={generation} />
      <ImageGenPreview generation={generation} onSendToVideo={onSendToVideo} />
    </form>
  );
}
