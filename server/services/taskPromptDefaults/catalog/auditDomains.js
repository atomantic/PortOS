import { CONSOLIDATED_AUDIT_DOMAINS } from '../../../lib/auditDomains.js';

export const prompts = Object.fromEntries(Object.entries(CONSOLIDATED_AUDIT_DOMAINS).map(([id, domain]) => [id,
  `[Improvement: {appName}] ${domain.label} audit

Repository: {repoPath}

{modeInstructions}

${domain.mission}`,
]));
