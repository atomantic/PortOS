import CatalogModelSelect from './CatalogModelSelect';
import { FAL_IMAGE_MODEL_OPTIONS, falImageFamily } from '../../lib/imageGenBackends';

// The fal.ai image model picker; the provider picks text vs /edit per render.
export default function FalModelSelect(props) {
  return <CatalogModelSelect {...props} options={FAL_IMAGE_MODEL_OPTIONS} familyOf={falImageFamily} providerLabel="fal.ai" />;
}
