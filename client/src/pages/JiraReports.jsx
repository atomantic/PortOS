import useListResource from '../hooks/useListResource';
import ListLoadError from '../components/ui/ListLoadError';
import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router';
import toast from '../components/ui/Toast';
import {FileText,
  RefreshCw,
  Copy,
  Check} from 'lucide-react';
import { getJiraReport, getJiraReports, generateJiraReport } from '../services/apiSystem.js';
import { getApps } from '../services/apiApps.js';
import BrailleSpinner from '../components/BrailleSpinner';
import { pluralize } from '../lib/textUtils';
import { copyToClipboard } from '../lib/clipboard';

function ReportCard({ report, onClick, isSelected }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-colors ${
        isSelected
          ? 'bg-port-accent/10 border-port-accent'
          : 'bg-port-card border-port-border hover:border-gray-600'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-white">{report.appName || report.appId}</span>
        <span className="text-xs text-gray-500">{report.date}</span>
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <span className="text-port-success">{report.summary.done} done</span>
        <span className="text-port-accent">{report.summary.inProgress} in progress</span>
        <span className="text-gray-500">{report.summary.todo} to do</span>
      </div>
    </button>
  );
}

const TICKET_KEY_RE = /^[A-Z]+-\d+$/;
const TICKET_KEY_SPLIT_RE = /([A-Z]+-\d+)/g;

function ReportDetail({ report }) {
  const [copied, setCopied] = useState(false);

  const ticketUrls = useMemo(() => {
    const urls = {};
    if (report?.tickets) {
      for (const group of Object.values(report.tickets)) {
        for (const t of group || []) {
          if (t.key && t.url) urls[t.key] = t.url;
        }
      }
    }
    return urls;
  }, [report]);

  if (!report) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Select a report to view details
      </div>
    );
  }

  const statusText = report.statusSummary || '';

  const handleCopy = async () => {
    const plain = statusText.replace(/\*\*/g, '');
    const ok = await copyToClipboard(plain, null);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-white">{report.appName || report.appId}</h3>
          <p className="text-sm text-gray-400">
            {report.projectKey} &middot; {report.date}
          </p>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded-lg border border-port-border hover:border-gray-500 transition-colors"
        >
          {copied ? <Check size={14} className="text-port-success" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy to Clipboard'}
        </button>
      </div>

      {statusText.trim() ? (
        <div className="text-sm text-gray-300 leading-relaxed">
          {statusText.split('\n').map((line, i) => {
            if (line.startsWith('**') && line.includes('**')) {
              return <div key={i} className="text-white font-semibold mt-4 first:mt-0 mb-1">{line.replace(/\*\*/g, '')}</div>;
            }
            if (line.startsWith('- ')) {
              const parts = line.slice(2).split(TICKET_KEY_SPLIT_RE);
              return (
                <div key={i} className="pl-3 py-0.5 text-gray-300">
                  {parts.map((part, j) => {
                    if (TICKET_KEY_RE.test(part)) {
                      const url = ticketUrls[part];
                      return url ? (
                        <a key={j} href={url} target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline font-mono text-xs">{part}</a>
                      ) : (
                        <span key={j} className="text-port-accent font-mono text-xs">{part}</span>
                      );
                    }
                    return <span key={j}>{part}</span>;
                  })}
                </div>
              );
            }
            return line ? <div key={i}>{line}</div> : <div key={i} className="h-2" />;
          })}
        </div>
      ) : (
        <div className="text-gray-500 text-sm">No ticket activity this week.</div>
      )}
    </div>
  );
}

const fetchReports = () => getJiraReports({ silent: true });

export default function JiraReports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { items: reports, state: reportsState, error: reportsError, retry: loadReports } = useListResource(fetchReports, { retainOnRetry: true });
  const [selectedReport, setSelectedReport] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [apps, setApps] = useState([]);
  const [appsLoaded, setAppsLoaded] = useState(false);

  const filterAppId = searchParams.get('app') || '';
  // The open report lives in the URL (`?reportApp=&reportDate=`) so it's
  // deep-linkable and reload-safe. appId + date is the report's stable id.
  const reportApp = searchParams.get('reportApp') || '';
  const reportDate = searchParams.get('reportDate') || '';

  useEffect(() => {
    loadApps();
  }, []);

  // Restore the URL-selected report: fetch the full record when the params name
  // one that isn't already loaded, and clear the selection when they're absent.
  // A stale id that no longer resolves leaves selectedReport null → the detail
  // pane falls back to its "Select a report" placeholder.
  useEffect(() => {
    if (!reportApp || !reportDate) { setSelectedReport(null); return; }
    if (selectedReport?.appId === reportApp && selectedReport?.date === reportDate) return;
    let cancelled = false;
    getJiraReport(reportApp, reportDate).then((full) => {
      // Clear the selection when the URL names a report that no longer resolves
      // (deleted / bad deep link) so the detail pane falls back to its
      // placeholder instead of stranding the previously-open report.
      if (!cancelled) setSelectedReport(full?.appId ? full : null);
    }).catch(() => { if (!cancelled) setSelectedReport(null); });
    return () => { cancelled = true; };
    // selectedReport intentionally omitted — the guard above prevents refetch loops.
  }, [reportApp, reportDate]);

  const selectReport = (appId, date) => {
    const p = new URLSearchParams(searchParams);
    p.set('reportApp', appId);
    p.set('reportDate', date);
    // Push (not replace) so Back returns to the previously-open report.
    setSearchParams(p);
  };

  const loadApps = async () => {
    // request() toasts a failure; a failed fetch is unknown, not an empty list, so appsLoaded stays false.
    const allApps = await getApps().catch(() => null);
    if (!allApps) return;
    const jiraApps = (allApps || []).filter(a => a.jira?.enabled);
    setApps(jiraApps);
    setAppsLoaded(true);
  };

  const handleGenerate = async (appId = null) => {
    setGenerating(true);
    // A failed generation must re-enable the Generate buttons (request() toasts the error).
    const result = await generateJiraReport(appId).catch(() => null);
    if (result) {
      const generated = Array.isArray(result) ? result.length : 1;
      const missed = appId ? 0 : apps.filter(a => a.jira.instanceId && a.jira.projectKey).length - generated;
      if (generated > 0 || missed <= 0) toast.success(appId ? 'Report generated' : `Generated ${pluralize(generated, 'report')}`);
      if (missed > 0) toast.error(`${pluralize(missed, 'project')} could not be reported. Check its JIRA instance.`);
      loadReports();
      if (!Array.isArray(result) && result.appId) {
        // Set the full record directly (avoids a redundant re-fetch — the effect's
        // guard sees the params already match) and reflect it in the URL.
        setSelectedReport(result);
        selectReport(result.appId, result.date);
      }
    }
    setGenerating(false);
  };

  const handleSelectReport = (reportMeta) => selectReport(reportMeta.appId, reportMeta.date);

  const handleFilterApp = (appId) => {
    // Changing the project filter drops the open report (its params too) so a
    // filtered-out selection can't linger.
    setSearchParams(appId ? { app: appId } : {});
  };

  // appsLoaded keeps the button enabled until the app list resolves, so a slow fetch is not mistaken for "no JIRA apps".
  const noJiraApps = appsLoaded && apps.length === 0;

  const filteredReports = filterAppId
    ? reports.filter(r => r.appId === filterAppId)
    : reports;

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-port-accent" />
          <h1 className="text-lg font-bold text-white">Weekly Status Reports</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {apps.length > 1 && (
            <select
              aria-label="Filter by app"
              value={filterAppId}
              onChange={e => handleFilterApp(e.target.value)}
              className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="">All Projects</option>
              {apps.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          )}
          <Link
            to="/devtools/jira"
            className="px-3 py-1.5 border border-port-border hover:border-port-accent text-gray-300 hover:text-white rounded text-sm transition-colors"
          >
            JIRA Instances
          </Link>
          <button
            onClick={() => handleGenerate(filterAppId || null)}
            disabled={generating || noJiraApps}
            aria-describedby={noJiraApps ? 'jira-reports-setup' : undefined}
            className="flex items-center gap-1.5 bg-port-accent hover:bg-port-accent/80 text-white text-sm px-3 py-1.5 rounded disabled:opacity-50"
          >
            {generating ? <BrailleSpinner /> : <RefreshCw size={14} />}
            {generating ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </div>

      {noJiraApps && (
        <p id="jira-reports-setup" className="text-sm text-gray-400 mb-4">
          Enable JIRA on an app first:{' '}
          <Link to="/apps" className="text-port-accent hover:underline">Apps</Link>
          {' '}and{' '}
          <Link to="/devtools/jira" className="text-port-accent hover:underline">JIRA Instances</Link>
        </p>
      )}

      {reportsState === 'error' && <ListLoadError what="JIRA reports" error={reportsError} onRetry={loadReports} className="mb-4" />}
      {reportsState === 'loading' && !reports.length ? (
        <div className="flex items-center justify-center h-64">
          <BrailleSpinner text="Loading" />
        </div>
      ) : filteredReports.length === 0 ? reportsState === 'ready' && (
        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
          <FileText size={48} className="mb-3 opacity-30" />
          <p>{noJiraApps ? 'No reports yet.' : 'No reports yet. Generate your first report above.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="space-y-2 lg:col-span-1 max-h-[calc(100dvh-160px)] overflow-y-auto pr-1">
            {filteredReports.map(r => (
              <ReportCard
                key={`${r.appId}-${r.date}`}
                report={r}
                onClick={() => handleSelectReport(r)}
                isSelected={selectedReport?.appId === r.appId && selectedReport?.date === r.date}
              />
            ))}
          </div>
          <div className="lg:col-span-2 bg-port-bg border border-port-border rounded-lg p-4 max-h-[calc(100dvh-160px)] overflow-y-auto">
            <ReportDetail report={selectedReport} />
          </div>
        </div>
      )}
    </div>
  );
}
