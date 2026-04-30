import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from '../components/ui/Toast';
import {FileText,
  RefreshCw,
  Copy,
  Check} from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';

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
    await navigator.clipboard.writeText(plain);
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

export default function JiraReports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [apps, setApps] = useState([]);

  const filterAppId = searchParams.get('app') || '';

  useEffect(() => {
    loadReports();
    loadApps();
  }, []);

  const loadApps = async () => {
    const allApps = await api.getApps();
    const jiraApps = (allApps || []).filter(a => a.jira?.enabled);
    setApps(jiraApps);
  };

  const loadReports = async () => {
    setLoading(true);
    const result = await api.getJiraReports();
    setReports(result || []);
    setLoading(false);
  };

  const handleGenerate = async (appId = null) => {
    setGenerating(true);
    const result = await api.generateJiraReport(appId);
    if (result) {
      toast.success(appId ? 'Report generated' : `Generated ${Array.isArray(result) ? result.length : 1} report(s)`);
      await loadReports();
      if (!Array.isArray(result) && result.appId) {
        setSelectedReport(result);
      }
    }
    setGenerating(false);
  };

  const handleSelectReport = async (reportMeta) => {
    const full = await api.getJiraReport(reportMeta.appId, reportMeta.date);
    if (full) setSelectedReport(full);
  };

  const handleFilterApp = (appId) => {
    if (appId) {
      setSearchParams({ app: appId });
    } else {
      setSearchParams({});
    }
    setSelectedReport(null);
  };

  const filteredReports = filterAppId
    ? reports.filter(r => r.appId === filterAppId)
    : reports;

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-port-accent" />
          <h1 className="text-lg font-bold text-white">Weekly Status Reports</h1>
        </div>
        <div className="flex items-center gap-2">
          {apps.length > 1 && (
            <select
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
          <button
            onClick={() => handleGenerate(filterAppId || null)}
            disabled={generating}
            className="flex items-center gap-1.5 bg-port-accent hover:bg-blue-600 text-white text-sm px-3 py-1.5 rounded disabled:opacity-50"
          >
            {generating ? <BrailleSpinner /> : <RefreshCw size={14} />}
            {generating ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <BrailleSpinner text="Loading" />
        </div>
      ) : filteredReports.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
          <FileText size={48} className="mb-3 opacity-30" />
          <p>No reports yet. Generate your first report above.</p>
          {apps.length === 0 && (
            <p className="text-xs mt-2">Enable JIRA on an app first (Apps &rarr; Edit &rarr; JIRA)</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="space-y-2 lg:col-span-1 max-h-[calc(100vh-160px)] overflow-y-auto pr-1">
            {filteredReports.map(r => (
              <ReportCard
                key={`${r.appId}-${r.date}`}
                report={r}
                onClick={() => handleSelectReport(r)}
                isSelected={selectedReport?.appId === r.appId && selectedReport?.date === r.date}
              />
            ))}
          </div>
          <div className="lg:col-span-2 bg-port-bg border border-port-border rounded-lg p-4 max-h-[calc(100vh-160px)] overflow-y-auto">
            <ReportDetail report={selectedReport} />
          </div>
        </div>
      )}
    </div>
  );
}
