/**
 * Scoped QR-Hosted Session Modal (#5383).
 *
 * Provides:
 * 1. HTTPS & subsystem readiness preflight verification.
 * 2. Scoped high-entropy QR code and fragment join link.
 * 3. Audio output target selection (Host computer speakers vs Audience phone).
 * 4. Realtime audience connection status.
 */

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Mic,
  QrCode,
  Radio,
  Smartphone,
  Speaker,
  Volume2,
  X,
} from 'lucide-react';
import toast from '../ui/Toast';
import { copyToClipboard } from '../../lib/clipboard';
import { generateQrCodeSvg } from '../../lib/qrCode';
import {
  createHostedLoomSession,
  endHostedLoomSession,
  preflightHostedLoomSession,
  updateHostedLoomSession,
} from '../../services/api';

export default function LoomHostedSessionModal({
  loom,
  episode,
  isOpen,
  onClose,
  activeSession,
  onSessionCreated,
  onSessionEnded,
  hasAudienceConnected = false,
}) {
  const [loading, setLoading] = useState(false);
  const [preflight, setPreflight] = useState(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [joinData, setJoinData] = useState(null); // { session, token, joinUrl }
  const [audioTarget, setAudioTarget] = useState('host');

  useEffect(() => {
    if (!isOpen || !loom?.id || !episode?.id) return;
    let canceled = false;
    setPreflightLoading(true);

    preflightHostedLoomSession(loom.id, episode.id)
      .then((data) => {
        if (!canceled) {
          setPreflight(data);
          setPreflightLoading(false);
        }
      })
      .catch((err) => {
        if (!canceled) {
          toast.error(`Preflight check failed: ${err.message}`);
          setPreflightLoading(false);
        }
      });

    return () => { canceled = true; };
  }, [isOpen, loom?.id, episode?.id]);

  if (!isOpen) return null;

  const currentJoinUrl = joinData?.joinUrl || activeSession?.joinUrl || null;
  const isSessionActive = Boolean(activeSession || joinData?.session);
  const currentSessionId = activeSession?.id || joinData?.session?.id;

  const handleStartSession = async () => {
    try {
      setLoading(true);
      const res = await createHostedLoomSession(loom.id, episode.id, { audioTarget });
      setJoinData(res);
      if (onSessionCreated) onSessionCreated(res.session, res);
      toast.success('Hosted play session created! Scan the QR code with your mobile device.');
    } catch (err) {
      toast.error(`Failed to create session: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEndSession = async () => {
    if (!currentSessionId) return;
    try {
      setLoading(true);
      await endHostedLoomSession(currentSessionId);
      setJoinData(null);
      if (onSessionEnded) onSessionEnded();
      toast.info('Hosted session ended.');
    } catch (err) {
      toast.error(`Failed to end session: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAudioTargetChange = async (target) => {
    setAudioTarget(target);
    if (currentSessionId) {
      try {
        await updateHostedLoomSession(currentSessionId, { audioTarget: target });
      } catch (err) {
        console.warn('Failed to update audio target:', err);
      }
    }
  };

  const handleCopyLink = async () => {
    if (!currentJoinUrl) return;
    const ok = await copyToClipboard(currentJoinUrl);
    if (ok) toast.success('Join link copied to clipboard!');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg bg-port-card border border-port-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-port-border bg-port-bg/50">
          <div className="flex items-center gap-2.5">
            <QrCode className="w-5 h-5 text-port-accent" />
            <h2 className="text-base font-semibold text-port-text">Hosted Two-Device Play</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-port-muted hover:text-port-text hover:bg-port-border/40 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Readiness Preflight Checklist */}
          {preflightLoading ? (
            <div className="flex items-center justify-center py-6 text-port-muted">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span>Checking system and HTTPS readiness…</span>
            </div>
          ) : preflight ? (
            <div className="space-y-3 p-3.5 rounded-lg bg-port-bg/40 border border-port-border text-xs">
              <div className="flex items-center justify-between font-medium text-port-text">
                <span>Readiness Preflight</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  preflight.ready ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
                }`}>
                  {preflight.ready ? 'Ready for Hosted Play' : 'Action Required'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-port-muted pt-1">
                <div className="flex items-center gap-1.5">
                  {preflight.checks.https.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                  <span>HTTPS: {preflight.checks.https.ok ? 'Active (TLS)' : 'Not Enabled'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {preflight.checks.host.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                  <span>Story Graph: {preflight.checks.host.ok ? 'Ready' : 'Missing Start'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {preflight.checks.tts.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
                  <span>Voice: {preflight.checks.tts.voice || 'Ready'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {preflight.checks.playback.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
                  <span>Hold Safety: {preflight.checks.playback.ok ? 'Safe' : 'Review'}</span>
                </div>
              </div>

              {preflight.errors.length > 0 && (
                <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] space-y-1">
                  {preflight.errors.map((err, i) => (
                    <div key={i}>• {err}</div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* Active Session QR Display */}
          {isSessionActive && currentJoinUrl ? (
            <div className="flex flex-col items-center space-y-4 py-2">
              <div
                className="p-3 bg-white rounded-xl shadow-lg border border-port-border"
                dangerouslySetInnerHTML={{ __html: generateQrCodeSvg(currentJoinUrl, { size: 200 }) }}
              />

              <div className="flex items-center gap-2 text-xs font-medium">
                <span className={`w-2.5 h-2.5 rounded-full animate-pulse ${hasAudienceConnected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                <span className="text-port-text">
                  {hasAudienceConnected ? 'Audience Mobile Device Connected!' : 'Waiting for phone to scan QR code…'}
                </span>
              </div>

              {/* Join Link Copy */}
              <div className="w-full flex items-center gap-2 p-2 rounded-lg bg-port-bg border border-port-border text-xs">
                <input
                  type="text"
                  readOnly
                  value={currentJoinUrl}
                  className="flex-1 bg-transparent border-none text-port-muted outline-none select-all font-mono text-[11px] truncate"
                />
                <button
                  onClick={handleCopyLink}
                  className="p-1.5 rounded text-port-muted hover:text-port-text hover:bg-port-card transition-colors shrink-0"
                  title="Copy link"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>

              {/* Audio Target Selector */}
              <div className="w-full space-y-2 pt-2 border-t border-port-border">
                <label className="text-xs font-medium text-port-text">Character Voice Output</label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => handleAudioTargetChange('host')}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all ${
                      audioTarget === 'host'
                        ? 'bg-port-accent/10 border-port-accent text-port-accent font-medium'
                        : 'bg-port-bg/40 border-port-border text-port-muted hover:text-port-text'
                    }`}
                  >
                    <Speaker className="w-4 h-4" />
                    <span>Computer Speakers</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAudioTargetChange('audience')}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all ${
                      audioTarget === 'audience'
                        ? 'bg-port-accent/10 border-port-accent text-port-accent font-medium'
                        : 'bg-port-bg/40 border-port-border text-port-muted hover:text-port-text'
                    }`}
                  >
                    <Smartphone className="w-4 h-4" />
                    <span>Audience Phone</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 space-y-3">
              <div className="p-3 bg-port-accent/10 text-port-accent w-12 h-12 rounded-full mx-auto flex items-center justify-center">
                <QrCode className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-port-text">Interactive Two-Device Play</h3>
                <p className="text-xs text-port-muted max-w-sm mx-auto">
                  Play the story video on this screen while using your phone as the microphone to speak with the protagonist.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-port-border bg-port-bg/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-port-muted hover:text-port-text transition-colors"
          >
            Close
          </button>

          {isSessionActive ? (
            <button
              onClick={handleEndSession}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-colors flex items-center gap-1.5"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>End Hosted Session</span>
            </button>
          ) : (
            <button
              onClick={handleStartSession}
              disabled={loading || (preflight && !preflight.ready)}
              className="px-4 py-2 text-xs font-semibold text-white bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg shadow transition-colors flex items-center gap-1.5"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Start Hosted Session</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
