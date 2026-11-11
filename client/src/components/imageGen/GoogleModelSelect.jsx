import CatalogModelSelect from './CatalogModelSelect';
import { GOOGLE_IMAGE_MODEL_OPTIONS, googleImageFamily } from '../../lib/imageGenBackends';

// The Google image model picker (Gemini image and Imagen 4).
export default function GoogleModelSelect(props) {
  return <CatalogModelSelect {...props} options={GOOGLE_IMAGE_MODEL_OPTIONS} familyOf={googleImageFamily} providerLabel="Google" />;
}
