/** Ordered story-bible vocabularies for visual identity and object attachments. */

// The required roles are the minimum visual identity anchors, in readiness and picker order.
export const IDENTITY_PACK_REQUIRED_ROLES = Object.freeze(['neutral', 'profile', 'full-body']);
export const IDENTITY_ASSET_ROLES = Object.freeze([
  ...IDENTITY_PACK_REQUIRED_ROLES, 'expression-gesture', 'wardrobe',
  'prop-scale', 'negative-identity',
]);

export const ATTACHMENT_ROLES = Object.freeze([
  'talisman', 'macguffin', 'memento', 'tool', 'symbol', 'custom',
]);
