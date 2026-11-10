/**
 * Google Cloud Vertex AI configuration vocabulary, a dependency-free leaf shared
 * by the settings schema (lib/validation.js) and the transport
 * (services/vertexApi.js). The location lands in an endpoint hostname, so it is
 * pattern-checked before it is ever used.
 */

export const VERTEX_DEFAULT_LOCATION = 'us-central1';
// A GCP region name (us-central1, europe-west4) or `global`.
export const VERTEX_LOCATION_PATTERN = /^(global|[a-z]+-[a-z]+\d+)$/;
// Google Cloud project ids: 6–30 chars, lowercase letters, digits and hyphens, starting with a letter.
export const VERTEX_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export const isValidVertexLocation = (value) => typeof value === 'string' && VERTEX_LOCATION_PATTERN.test(value);
export const isValidVertexProjectId = (value) => typeof value === 'string' && VERTEX_PROJECT_ID_PATTERN.test(value);
