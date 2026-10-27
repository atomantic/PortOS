/** Current shipped starters. Only text fields are eligible for restoration. */
import { REALITY_STARTER_V2 } from './realityStarterV2.js';

export const REALITY_STARTER_ID = 'universe-reality';
export function universeStarterPatch(id) {
  return id === REALITY_STARTER_ID ? structuredClone(REALITY_STARTER_V2) : null;
}
