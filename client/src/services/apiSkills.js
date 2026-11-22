/**
 * Agent Skill Registry and Skill Curator API: listing, Level 1 reads, human edits, curator status/pass, lifecycle controls and the mutation ledger.
 *
 * Every wrapper takes `options` (e.g. `{ silent: true }`) so a caller that owns
 * its error UI suppresses request()'s default toast. `editSkill` is the human
 * edit route, which a skill's lock does not stop; agents use `/skills/manage`.
 */

import { request } from './apiCore.js';

const postBody = (body) => ({ method: 'POST', body: JSON.stringify(body) });

export const getSkills = (options) => request('/skills', options);
export const viewSkill = (ref, options) => request(`/skills/view?ref=${encodeURIComponent(ref)}`, options);
export const editSkill = (body, options) => request('/skills/edit', { ...postBody(body), ...options });

export const getCuratorStatus = (options) => request('/skills/curator/status', options);
export const runCurator = ({ dryRun = false } = {}, options) => request('/skills/curator/run', { ...postBody({ dryRun }), ...options });

/** `action`: pin | unpin | lock | unlock | archive | restore | adopt. */
export const applySkillAction = (ref, action, options) => request(`/skills/${encodeURIComponent(ref)}/${encodeURIComponent(action)}`, { ...postBody({}), ...options });

export const getSkillLedger = ({ limit } = {}, options) => request(`/skills/ledger${limit ? `?limit=${limit}` : ''}`, options);
export const rollbackSkillLedgerEntry = (entryId, options) => request(`/skills/ledger/${encodeURIComponent(entryId)}/rollback`, { ...postBody({}), ...options });
