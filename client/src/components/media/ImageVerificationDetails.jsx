/**
 * ImageVerificationDetails.jsx — Detailed visual quality & anatomical defect
 * inspection card with on-demand verification and manual operator override.
 */

import { useState } from 'react';
import { ShieldCheck, AlertTriangle, CheckCircle2, RotateCw, Sparkles, UserCheck, Loader2 } from 'lucide-react';
import { verifyImageNow, overrideVerification } from '../../services/apiImageVerifier.js';
import toast from '../ui/Toast.jsx';

export const PROFILE_OPTIONS = [
  { id: 'strict_anatomy', label: 'Strict Anatomy (Hands & Limbs)' },
  { id: 'composition_and_text', label: 'Composition & Typography' },
  { id: 'full_audit', label: 'Comprehensive Quality Audit' },
  { id: 'quick_screen', label: 'Quick Defect Screen' },
];

export const REVIEWER_MODEL_OPTIONS = [
  { id: 'auto', label: 'Auto (Recommended Reviewer)' },
  { id: 'gemini-4-argon', label: 'Google Gemini 4 Argon' },
  { id: 'qwen-27b', label: 'Qwen 27B / 27G (Local)' },
  { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
  { id: 'kimi-k2.5', label: 'Kimi K2.5 / Moonshot' },
];

export default function ImageVerificationDetails({ item, onVerificationChange }) {
  const [selectedProfile, setSelectedProfile] = useState('strict_anatomy');
  const [selectedModel, setSelectedModel] = useState('auto');
  const [verifying, setVerifying] = useState(false);
  const [overriding, setOverriding] = useState(false);

  const verification = item?.verification;
  const isVideo = item?.kind === 'video';

  if (isVideo || !item?.filename) return null;

  const handleRunVerification = async () => {
    setVerifying(true);
    try {
      const result = await verifyImageNow({
        filename: item.filename,
        profileId: selectedProfile,
        prompt: item.prompt || '',
        reviewerModel: selectedModel !== 'auto' ? selectedModel : undefined,
      });
      if (result) {
        onVerificationChange?.(result);
        if (result.verdict === 'pass') {
          toast.success('Image verified clean — no defects detected.');
        } else if (result.verdict === 'fail') {
          toast.warning(`Defects detected: ${result.summary}`);
        } else {
          toast.info('Verification complete.');
        }
      }
    } catch (err) {
      toast.error(`Verification failed: ${err.message || 'Error running inspection'}`);
    } finally {
      setVerifying(false);
    }
  };

  const handleOverridePass = async () => {
    setOverriding(true);
    try {
      const updated = await overrideVerification({
        filename: item.filename,
        verdict: 'pass',
        notes: 'Operator verified clean / false positive override',
      });
      if (updated) {
        onVerificationChange?.(updated);
        toast.success('Marked image as verified clean (operator override).');
      }
    } catch (err) {
      toast.error(`Failed to override verification: ${err.message}`);
    } finally {
      setOverriding(false);
    }
  };

  return (
    <div className="rounded-lg border border-port-border bg-port-bg/40 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-300">
          <ShieldCheck className="w-4 h-4 text-port-accent" />
          <span>Quality & Anatomy Verification</span>
        </div>
        {verification && (
          <span
            className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
              verification.overridden
                ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                : verification.verdict === 'pass'
                  ? 'bg-port-success/20 text-port-success border border-port-success/30'
                  : 'bg-port-error/20 text-port-error border border-port-error/30'
            }`}
          >
            {verification.overridden ? (
              <UserCheck className="w-3 h-3" />
            ) : verification.verdict === 'pass' ? (
              <CheckCircle2 className="w-3 h-3" />
            ) : (
              <AlertTriangle className="w-3 h-3" />
            )}
            {verification.overridden
              ? 'Override (Pass)'
              : verification.verdict === 'pass'
                ? 'Passed Checks'
                : 'Defect Flagged'}
          </span>
        )}
      </div>

      {verification ? (
        <div className="space-y-2 text-xs">
          <p className="text-gray-300 leading-relaxed bg-port-card/60 p-2 rounded border border-port-border/50">
            {verification.summary || (verification.verdict === 'pass' ? 'All anatomical and quality checks passed.' : 'Defects detected.')}
          </p>

          {verification.reviewerModel && (
            <div className="text-[10px] text-gray-400 font-mono flex items-center gap-1">
              <span>Audited by:</span>
              <span className="text-port-accent">
                {/argon/i.test(verification.reviewerModel)
                  ? 'Gemini 4 Argon'
                  : /qwen.*(?:27[bg]|3\.8)/i.test(verification.reviewerModel)
                    ? 'Qwen 27B/27G'
                    : verification.reviewerModel}
              </span>
            </div>
          )}

          {Array.isArray(verification.defects) && verification.defects.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase font-bold text-port-error tracking-wider">
                Flagged Defects ({verification.defects.length}):
              </span>
              <div className="space-y-1">
                {verification.defects.map((d, i) => (
                  <div key={i} className="flex items-start gap-1.5 p-1.5 rounded bg-port-error/10 border border-port-error/20 text-port-error text-[11px]">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold capitalize">{d.dimension.replace(/_/g, ' ')}: </span>
                      <span>{d.claim}</span>
                      {d.region && <span className="text-gray-400 block text-[10px]">Location: {d.region}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(verification.hands) && verification.hands.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                Examined Hands ({verification.hands.length}):
              </span>
              <div className="grid grid-cols-1 gap-1">
                {verification.hands.map((h, i) => (
                  <div
                    key={i}
                    className={`flex items-center justify-between px-2 py-1 rounded text-[11px] border ${
                      h.status === 'fail'
                        ? 'bg-port-error/10 border-port-error/30 text-port-error'
                        : 'bg-port-card border-port-border/40 text-gray-300'
                    }`}
                  >
                    <span className="truncate pr-2">{h.location || `Hand ${i + 1}`}</span>
                    <span className="font-mono shrink-0">
                      {h.visibleDigits != null ? `${h.visibleDigits} digits` : 'unclear'} · {h.status === 'pass' ? '✓' : '⚠'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-port-border/40">
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value)}
              disabled={verifying}
              className="text-[11px] bg-port-card border border-port-border rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-port-accent"
              title="Select verification profile"
            >
              {PROFILE_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={verifying}
              className="text-[11px] bg-port-card border border-port-border rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-port-accent"
              title="Select vision reviewer model"
            >
              {REVIEWER_MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleRunVerification}
              disabled={verifying}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-port-accent/80 hover:bg-port-accent text-white rounded transition-colors disabled:opacity-50"
            >
              {verifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
              {verifying ? 'Verifying...' : 'Re-verify'}
            </button>
            {verification.verdict === 'fail' && !verification.overridden && (
              <button
                type="button"
                onClick={handleOverridePass}
                disabled={overriding}
                title="Mark this image as verified clean if the reported defect is a false alarm or intentional stylization"
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 border border-purple-500/30 rounded transition-colors"
              >
                <UserCheck className="w-3 h-3" />
                Force Pass (False Alarm)
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          <p className="text-gray-400 text-[11px]">
            Run multimodal vision verification on this image to check finger counts, detect extra/missing limbs, identify garbled text, and audit composition.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value)}
              disabled={verifying}
              className="text-[11px] bg-port-card border border-port-border rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-port-accent"
              title="Select verification profile"
            >
              {PROFILE_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={verifying}
              className="text-[11px] bg-port-card border border-port-border rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-port-accent"
              title="Select vision reviewer model"
            >
              {REVIEWER_MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleRunVerification}
              disabled={verifying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-port-accent hover:bg-port-accent/90 text-white rounded transition-colors disabled:opacity-50"
            >
              {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              {verifying ? 'Verifying anatomy & quality...' : 'Verify Image'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
