/**
 * Normalize code reviewer verdicts and define the heading contract for rendered findings.
 */

export const REVIEW_FINDING_HEADINGS = Object.freeze({
  blocking: 'Priority findings',
  recommended: 'Additional findings',
})
export const REVIEW_FINDING_HEADING_SUFFIX = ' — resolution required'

// An agentic CLI reviewer (agy) routinely returns the requested envelope as ONE
// markdown-fenced block despite "no markdown" — the reply is the whole envelope,
// only dressed. Unwrap it only when the fence spans the entire reply, so prose
// before/after a fence, an unclosed (truncated) fence, or several blocks still
// fall through to the strict parse and stay inconclusive (#10832).
const WHOLE_REPLY_JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i

// Transport success is not a review verdict. Accept only the exact legacy
// clean reply or the complete bounded envelope we request; never extract a
// clean substring from contradictory prose or salvage a truncated JSON reply.
export function normalizeCodeReviewVerdict(content) {
  const trimmed = typeof content === 'string' ? content.trim() : ''
  if (/^no findings\.?$/i.test(trimmed)) return { verdict: { verdict: 'clean', findings: trimmed } }
  const text = WHOLE_REPLY_JSON_FENCE.exec(trimmed)?.[1].trim() ?? trimmed
  if (text.length > 20000) return { reason: 'oversized_content' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { reason: 'invalid_json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'findings,verdict'
      || !Array.isArray(parsed.findings)) return { reason: 'invalid_envelope' }
  if (parsed.verdict === 'clean') {
    return parsed.findings.length === 0 ? { verdict: { verdict: 'clean', findings: 'No findings.' } } : { reason: 'verdict_findings_mismatch' }
  }
  if (!['clean', 'findings'].includes(parsed.verdict)) return { reason: 'invalid_envelope' }
  if (parsed.findings.length === 0) return { reason: 'verdict_findings_mismatch' }
  const completeText = value => typeof value === 'string' && value.trim().length > 0
    && value.length <= 1000 && !/^no findings\.?$/i.test(value.trim())
  if (parsed.findings.some(finding => !finding || typeof finding !== 'object' || Array.isArray(finding)
      || Object.keys(finding).sort().join(',') !== 'fix,location,outcome,severity'
      || !['blocking', 'recommended'].includes(finding.severity)
      || !['location', 'outcome', 'fix'].every(key => completeText(finding[key])))) return { reason: 'incomplete_finding' }
  const findings = ['blocking', 'recommended'].flatMap(severity => {
    const rows = parsed.findings.filter(finding => finding.severity === severity)
    return rows.length ? [
      `## ${REVIEW_FINDING_HEADINGS[severity]}${REVIEW_FINDING_HEADING_SUFFIX}`,
      ...rows.map(finding => `- ${finding.location.trim()}: ${finding.outcome.trim()} ${finding.fix.trim()}`),
    ] : []
  }).join('\n\n')
  return { verdict: { verdict: 'findings', findings } }
}
