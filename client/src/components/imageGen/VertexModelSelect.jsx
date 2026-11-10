import CatalogModelSelect from './CatalogModelSelect';
import { VERTEX_IMAGE_MODEL_OPTIONS, vertexImageFamily } from '../../lib/imageGenBackends';

// The Vertex AI image model picker (Gemini image and Imagen 4).
export default function VertexModelSelect(props) {
  return <CatalogModelSelect {...props} options={VERTEX_IMAGE_MODEL_OPTIONS} familyOf={vertexImageFamily} providerLabel="Vertex AI" />;
}
