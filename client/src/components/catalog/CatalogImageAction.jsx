import { useCallback } from 'react';
import { getCatalogIngredientDetails, attachCatalogIngredientMedia, setCatalogIngredientPortrait } from '../../services/apiCatalog';
import { buildGenerationPromptSeed } from '../../lib/catalogImagePrompt';
import { getCatalogType } from '../../lib/catalogTypes';
import GenerateImageControl from './GenerateImageControl';
import toast from '../ui/Toast';

export default function CatalogImageAction({ ingredient, getType = getCatalogType, disabled = false, onCover }) {
  // Cards may carry a bounded payload projection. Read the complete current
  // record on demand, and take style ownership from its explicit owner.
  const loadSource = async () => {
    const details = await getCatalogIngredientDetails(ingredient.id, { silent: true });
    const record = details?.ingredient;
    if (!record) throw new Error('The catalog record is unavailable.');
    if (details.sharedIdentity?.writable === false) throw new Error('This shared identity is read-only here.');
    if (details.universeContext?.status === 'conflict') throw new Error('Resolve universe ownership before generating an image.');
    return { name: record.name, description: buildGenerationPromptSeed(record.payload, getType(record.type), record.tags),
      universeId: details.universeContext?.owner?.refId || null };
  };
  const complete = useCallback(async filename => {
    await getCatalogIngredientDetails(ingredient.id, { silent: true }).then(async details => {
      const media = details.media || [];
      if (!media.some(item => item.mediaKey === filename)) {
        if (media.some(item => item.kind === 'portrait')) await attachCatalogIngredientMedia(ingredient.id, { mediaKey: filename, kind: 'reference' }, { silent: true });
        else await setCatalogIngredientPortrait(ingredient.id, { mediaKey: filename }, { silent: true });
      }
      const portrait = media.find(item => item.kind === 'portrait');
      onCover?.(`/data/images/${encodeURIComponent(portrait?.mediaKey || filename)}`);
    }).catch(error => toast.error(error.message || 'Could not attach the generated image'));
  }, [ingredient.id, onCover]);

  return <GenerateImageControl key={ingredient.id} ingredientId={ingredient.id} name={ingredient.name || '(untitled)'} quick
    loadSource={loadSource} onComplete={complete} disabled={disabled || ingredient.sharedIdentity?.writable === false} />;
}
