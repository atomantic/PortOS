import { describe, it, expect } from 'vitest';
import {
  ACTIVE_AUDIT_DOMAIN_IDS,
  AUDIT_DOMAIN_ALIASES,
  PRIORITY_EXEMPT_AUDIT_DOMAINS,
  QUALITY_RECENCY_HALF_LIFE_DAYS,
  isPriorityExemptAuditType,
} from './auditDomains.js';
import { QUALITY_RECENCY_HALF_LIFE_DAYS as qualityHalfLife } from './auditQuality.js';

describe('isPriorityExemptAuditType', () => {
  const exempt = ['security', 'privacy', 'data-integrity-safety', 'data-safety', 'data-integrity', 'upgrade-rehearsal'];

  it('exempts the security, privacy and data-safety audits, including their folded task ids', () => {
    for (const id of exempt) expect(isPriorityExemptAuditType(id), id).toBe(true);
  });

  it('leaves every other active audit domain subject to priority', () => {
    const others = ACTIVE_AUDIT_DOMAIN_IDS.filter((id) => !PRIORITY_EXEMPT_AUDIT_DOMAINS.includes(id));
    expect(others.length).toBeGreaterThan(0);
    for (const id of others) expect(isPriorityExemptAuditType(id), id).toBe(false);
  });

  it('decides folded task ids through their domain', () => {
    const folded = Object.keys(AUDIT_DOMAIN_ALIASES).filter((id) => !exempt.includes(id));
    for (const id of folded) expect(isPriorityExemptAuditType(id), id).toBe(false);
  });

  it('is false for an unknown task type', () => {
    expect(isPriorityExemptAuditType('not-an-audit')).toBe(false);
  });
});

describe('QUALITY_RECENCY_HALF_LIFE_DAYS', () => {
  it('stays one value shared by quality scoring and feature priority', () => {
    expect(QUALITY_RECENCY_HALF_LIFE_DAYS).toBe(14);
    expect(qualityHalfLife).toBe(QUALITY_RECENCY_HALF_LIFE_DAYS);
  });
});
