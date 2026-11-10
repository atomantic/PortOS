import CatalogModelSelect from './CatalogModelSelect';
import { HIGGSFIELD_IMAGE_MODEL_OPTIONS, higgsfieldImageFamily } from '../../lib/imageGenBackends';

// The Higgsfield image model picker; the provider picks text vs edit per render.
export default function HiggsfieldModelSelect(props) {
  return <CatalogModelSelect {...props} options={HIGGSFIELD_IMAGE_MODEL_OPTIONS} familyOf={higgsfieldImageFamily} providerLabel="Higgsfield" />;
}
