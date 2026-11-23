import { useEffect, useState } from 'react';
import { Images, Link2, X } from 'lucide-react';
import IngredientPicker from '../IngredientPicker';
import MediaImage from '../MediaImage';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow';
import MoodBoardPinPicker from '../storyboards/MoodBoardPinPicker';
import { listMoodBoardNames } from '../../services/apiMoodBoard.js';
import { referenceImageUrls } from '../../lib/blenderModels.js';
import { buttonCls, inputCls, labelCls } from '../musicVideo/blender/blenderStyles.js';

/** What the sheets are drawn from: a Casting object, library images, uploads or mood-board pins, the real size and the renderer. */
export default function BlenderModelReferenceSource({ model }) {
  const { state, pending } = model;
  const source = state.referenceSource;
  const saving = !!pending.referenceSource;
  // null until edited, so a size set elsewhere shows while nothing is being typed.
  const [size, setSize] = useState(null);
  const [picker, setPicker] = useState(null);
  const [boards, setBoards] = useState([]);
  const [boardId, setBoardId] = useState('');
  useEffect(() => {
    let active = true;
    listMoodBoardNames({ silent: true }).then((list) => { if (active && Array.isArray(list)) setBoards(list); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const save = (patch) => model.updateReferenceSource(patch);
  const addImage = (filename, label) => {
    if (filename && !source.images.some((image) => image.filename === filename)) save({ images: [...source.images, { filename, label }] });
  };
  const saveSize = async () => {
    if (size === null) return;
    if (size.trim() === source.size || (await save({ size: size.trim() })).ok) setSize(null);
  };

  return (
    <section aria-label="Reference source" className="min-w-0 space-y-3">
      <h2 className="text-sm font-medium">Source</h2>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {source.ingredientId && <span className="min-w-0 break-words text-sm">{source.name}</span>}
        <button type="button" className={buttonCls} disabled={saving} onClick={() => setPicker('casting')}>
          <Link2 size={14} aria-hidden="true" /> {source.ingredientId ? 'Change Casting object' : 'Casting object'}
        </button>
        {source.ingredientId && <button type="button" className={buttonCls} disabled={saving} onClick={() => save({ ingredientId: null })}>Unlink</button>}
        <button type="button" className={buttonCls} disabled={saving} onClick={() => setPicker('gallery')}><Images size={14} aria-hidden="true" /> Gallery or upload</button>
        {boards.length > 0 && (
          <div className="min-w-0">
            <label htmlFor="bm-board" className="sr-only">Mood board</label>
            <select id="bm-board" className={inputCls} value="" disabled={saving} onChange={(event) => setBoardId(event.target.value)}>
              <option value="">Mood board pin…</option>
              {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
            </select>
          </div>
        )}
      </div>
      {source.images.length > 0 && (
        <ul className="grid min-w-0 grid-cols-2 gap-2 @lg:grid-cols-4 @3xl:grid-cols-6">
          {source.images.map((image) => {
            const [src, fallback] = referenceImageUrls(image.filename);
            return (
              <li key={image.filename} className="min-w-0 rounded border border-port-border">
                <MediaImage src={src} thumbnail fallbackSrc={fallback} alt={image.label || image.filename} loading="lazy" className="h-28 w-full object-contain" />
                <div className="flex min-w-0 items-center gap-1 p-1 text-xs">
                  <span className="min-w-0 flex-1 truncate" title={image.label || image.filename}>{image.label || image.filename}</span>
                  <button type="button" disabled={saving} aria-label={`Remove ${image.label || image.filename}`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center"
                    onClick={() => save({ images: source.images.filter((entry) => entry.filename !== image.filename) })}><X size={14} aria-hidden="true" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="max-w-xl min-w-0">
        <label htmlFor="bm-size" className={labelCls}>Real size (stated on the sheet)</label>
        <input id="bm-size" className={inputCls} value={size ?? source.size} maxLength={200} placeholder="22 × 22 × 52 cm" onChange={(event) => setSize(event.target.value)} onBlur={saveSize} />
      </div>
      <RecordRenderPinRow idPrefix="bm-reference" label="Draw with" imageMode={source.imageMode} imageModelId={source.imageModelId}
        autoLabel="Default for character sheets" onChange={save} />
      <IngredientPicker open={picker === 'casting'} type="object" onClose={() => setPicker(null)} onSelect={(object) => { setPicker(null); save({ ingredientId: object.id }); }} />
      <GalleryImagePicker open={picker === 'gallery'} allowUpload onClose={() => setPicker(null)} onSelect={(item) => addImage(item?.filename, '')} />
      <MoodBoardPinPicker open={!!boardId} moodBoardId={boardId} onClose={() => setBoardId('')} onSelect={(pin) => addImage(pin.filename, pin.caption.slice(0, 200))} />
    </section>
  );
}
