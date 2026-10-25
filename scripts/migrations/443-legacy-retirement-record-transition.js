import { join } from "node:path";
import { readJSONFile } from "../../server/lib/jsonIo.js";
import { markLegacyRetirements } from "../../server/lib/legacyRetirementTransition.js";
import { writeJsonAtomic } from "./_lib.js";

/** Mark existing bookkeeping for evidence-based transition; erase no work or history. */
export default {
	async up({ rootDir }) {
		const path = join(rootDir, "data/cos/task-schedule.json");
		const schedule = await readJSONFile(path, null, { strict: true });
		if (!schedule) return { marked: 0 };
    const policyChanged = schedule.retirementPolicyVersion !== 2;
    schedule.retirementPolicyVersion = 2;
		let marked = 0;
		const execution = schedule.executions?.["task:branch-reconcile"];
		for (const record of [
			execution,
			...Object.values(execution?.perApp || {}),
		]) {
			if (markLegacyRetirements(record?.branchReconcileOutcome)) marked++;
		}
    if (marked || policyChanged) await writeJsonAtomic(path, schedule);
		return { marked };
	},
};
