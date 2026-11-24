// Memory types promoted before memoryTypeEnum alignment; map them to canonical types when hydrating edit forms.
const LEGACY_MEMORY_TYPES = { insight: 'learning', pattern: 'observation' };

export const normalizeMemoryType = (type) => LEGACY_MEMORY_TYPES[type] ?? (type || 'observation');
