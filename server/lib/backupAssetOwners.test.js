import { describe, expect, it } from 'vitest';
import { BACKUP_ASSET_OWNERS, backupAssetConsistency } from './backupAssetOwners.js';

describe('backupAssetConsistency', () => {
  it('claims global consistency only when no owner is outstanding', () => {
    expect(backupAssetConsistency([
      { id: 'example-admitted', status: 'admitted', modules: [] },
      { id: 'example-reference', status: 'reference-only', modules: [] },
    ])).toEqual({ scope: 'global', outstanding: [] });
    expect(backupAssetConsistency([
      { id: 'example-admitted', status: 'admitted', modules: [] },
      { id: 'example-outstanding', status: 'outstanding', modules: [] },
    ])).toEqual({ scope: 'admitted-owners', outstanding: ['example-outstanding'] });
  });

  it('treats an unrecognized status as outstanding rather than covered', () => {
    expect(backupAssetConsistency([{ id: 'example-typo', status: 'admited', modules: [] }]))
      .toEqual({ scope: 'admitted-owners', outstanding: ['example-typo'] });
  });

  it('claims global consistency for the shipped exception inventory', () => {
    const outstanding = BACKUP_ASSET_OWNERS.filter(owner => owner.status === 'outstanding').map(owner => owner.id);
    expect(outstanding).toEqual([]);
    expect(backupAssetConsistency()).toEqual({ scope: 'global', outstanding });
  });
});
