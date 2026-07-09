import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, KeyRound, Building2, ArrowRight, ShieldOff } from 'lucide-react';
import { getPrivacyStatus, getPrivacyOrgs, getPrivacyScanStatus } from '../../services/api';
import {
  VAULT_TYPES, ORG_TRUST_LEVELS, TRUST_TONE, labelFor, CASE_STATES, CASE_STATE_TONE,
} from './constants';

// Broker case states surfaced on the Overview summary (#2146).
const OVERVIEW_BROKER_STATES = ['found', 'optout_in_progress', 'human_task_queued', 'confirmed_removed'];

export default function PrivacyOverviewTab() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [scanStatus, setScanStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([getPrivacyStatus(), getPrivacyOrgs(), getPrivacyScanStatus()]).then(([s, o, b]) => {
      setStatus(s.status === 'fulfilled' ? s.value : { keyConfigured: false, recordCounts: {} });
      setOrgs(o.status === 'fulfilled' ? o.value : []);
      setScanStatus(b.status === 'fulfilled' ? b.value : { caseCounts: {}, enabledBrokers: 0 });
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-gray-500 text-sm py-8 text-center">Loading privacy status…</div>;

  const recordCounts = status?.recordCounts || {};
  const totalRecords = Object.values(recordCounts).reduce((a, b) => a + b, 0);
  const keyConfigured = status?.keyConfigured !== false;

  const trustCounts = ORG_TRUST_LEVELS.map((t) => ({
    ...t,
    count: orgs.filter((o) => o.trust === t.id).length,
  }));

  const caseCounts = scanStatus?.caseCounts || {};
  const totalCases = Object.values(caseCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500 max-w-2xl">
        The Privacy Center is your system of record for personal identity facts and who holds them.
        Vault values are encrypted at rest and never shown until you explicitly reveal them.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Encryption status */}
        <div className="bg-port-card border border-port-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={18} className="text-port-accent" />
            <span className="text-sm font-semibold text-white">Encryption</span>
          </div>
          {keyConfigured ? (
            <div className="flex items-center gap-2 text-port-success text-sm">
              <ShieldCheck size={16} /> Engaged (AES-256-GCM)
            </div>
          ) : (
            <div className="flex items-center gap-2 text-port-warning text-sm">
              <ShieldAlert size={16} /> Key auto-provisions on first record
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Protects against DB / backup / disk exposure — not a live host compromise.
          </p>
        </div>

        {/* Vault records */}
        <button
          onClick={() => navigate('/privacy/vault')}
          className="text-left bg-port-card border border-port-border rounded-lg p-5 hover:border-port-accent/50 transition-colors group"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-white">Vault records</span>
            <ArrowRight size={16} className="text-gray-600 group-hover:text-port-accent transition-colors" />
          </div>
          <div className="text-2xl font-bold text-white mb-1">{totalRecords}</div>
          <div className="flex flex-wrap gap-1.5">
            {VAULT_TYPES.filter((t) => recordCounts[t.id]).map((t) => (
              <span key={t.id} className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
                {recordCounts[t.id]} {t.label.toLowerCase()}
              </span>
            ))}
            {totalRecords === 0 && <span className="text-xs text-gray-500">No records yet</span>}
          </div>
        </button>

        {/* Organizations */}
        <button
          onClick={() => navigate('/privacy/organizations')}
          className="text-left bg-port-card border border-port-border rounded-lg p-5 hover:border-port-accent/50 transition-colors group"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-white">
              <Building2 size={16} className="text-gray-500" /> Organizations
            </span>
            <ArrowRight size={16} className="text-gray-600 group-hover:text-port-accent transition-colors" />
          </div>
          <div className="text-2xl font-bold text-white mb-1">{orgs.length}</div>
          <div className="flex flex-wrap gap-1.5">
            {trustCounts.filter((t) => t.count > 0).map((t) => (
              <span key={t.id} className={`text-[10px] px-1.5 py-0.5 rounded border ${TRUST_TONE[t.id] || ''}`}>
                {t.count} {labelFor(ORG_TRUST_LEVELS, t.id).toLowerCase()}
              </span>
            ))}
            {orgs.length === 0 && <span className="text-xs text-gray-500">None tracked yet</span>}
          </div>
        </button>
      </div>

      {/* Data-broker exposure summary (#2146) */}
      <button
        onClick={() => navigate('/privacy/brokers')}
        className="w-full text-left bg-port-card border border-port-border rounded-lg p-5 hover:border-port-accent/50 transition-colors group"
      >
        <div className="flex items-center justify-between mb-3">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-white">
            <ShieldOff size={16} className="text-gray-500" /> Data brokers
          </span>
          <ArrowRight size={16} className="text-gray-600 group-hover:text-port-accent transition-colors" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {totalCases === 0 ? (
            <span className="text-xs text-gray-500">
              {scanStatus?.enabledBrokers || 0} brokers tracked — no scan run yet
            </span>
          ) : (
            OVERVIEW_BROKER_STATES.filter((st) => caseCounts[st]).map((st) => (
              <span key={st} className={`text-[10px] px-1.5 py-0.5 rounded border ${CASE_STATE_TONE[st] || ''}`}>
                {caseCounts[st]} {labelFor(CASE_STATES, st).toLowerCase()}
              </span>
            ))
          )}
        </div>
      </button>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => navigate('/privacy/vault')} className="px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80">
          Manage vault
        </button>
        <button onClick={() => navigate('/privacy/organizations')} className="px-3 py-2 text-sm rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-card">
          Manage organizations
        </button>
      </div>
    </div>
  );
}
