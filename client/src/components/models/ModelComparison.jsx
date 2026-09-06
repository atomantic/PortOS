import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ArrowUpRight,
  ChartScatter,
  Check,
  CloudDownload,
  Focus,
  MoveHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getModelComparison,
  importModelComparison,
  discoverComparisonModels,
  syncArtificialAnalysis,
} from '../../services/apiModelComparison';
import Modal from '../ui/Modal';
import ComparisonResearch from './ComparisonResearch';
import { EFFORT_LADDER, withEstimatedCosts } from '../../lib/effortCostEstimate';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const SETTINGS_STORAGE_KEY = 'portos-model-comparison-settings';

const COLORS = [
  '#2563eb', // blue (GPT-5.6 Sol)
  '#f97316', // orange (GPT-5.6 Terra)
  '#16a34a', // green (GPT-5.6 Luna)
  '#dc2626', // red (GPT-5.5)
  '#9333ea', // purple
  '#0891b2', // cyan
  '#db2777', // pink
  '#ca8a04', // yellow
  '#0d9488', // teal
  '#e11d48', // rose
  '#7c3aed', // violet
  '#059669', // emerald
  '#4f46e5', // indigo
  '#d97706', // amber
  '#475569', // slate
  '#0284c7', // light blue
];

const METRICS = [
  'quality',
  'costPerTask',
  'inputPerMillion',
  'outputPerMillion',
  'reasoningPerMillion',
  'responseSeconds',
  'tokensPerSecond',
  'quota',
];

// Where each effort sits on a model's curve. The ladder itself comes from the
// estimator so the two can't drift; the rest are the model-level configurations
// that are not points on it, plus the aliases the sources use.
const EFFORT_ORDER = {
  'non-reasoning': 0,
  none: 0,
  unspecified: 0.5,
  ...Object.fromEntries(EFFORT_LADDER.map((effort, index) => [effort, index + 1])),
  very_high: EFFORT_LADDER.indexOf('xhigh') + 1,
  reasoning: EFFORT_LADDER.length + 1,
};

const AXES = {
  cost: { label: 'Cost per task (USD)', short: 'cost per task', money: true, prefer: 'lower' },
  quality: { label: 'Benchmark score', short: 'index score', prefer: 'higher' },
  tokensPerSecond: { label: 'Speed (tokens/s)', short: 'speed', prefer: 'higher' },
  responseSeconds: { label: 'Response time (seconds)', short: 'response time', prefer: 'lower' },
  inputPerMillion: { label: 'Input price (USD / 1M tokens)', short: 'input price', money: true, prefer: 'lower' },
  outputPerMillion: { label: 'Output price (USD / 1M tokens)', short: 'output price', money: true, prefer: 'lower' },
};

const STALE_MS = 30 * 86400000;

function getModelDisplayName(row) {
  if (row.notes) {
    const match = row.notes.match(/Sourced from Artificial Analysis \((.*?)(?:\s*\(.*?\))?\)\./);
    if (match && match[1]) return match[1].trim();
  }
  return row.model;
}

export default function ModelComparison() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const [scenario, setScenario] = useState({ input: 10000, output: 500, reasoning: 0, tasks: 100 });
  const [modelSearch, setModelSearch] = useState('');
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncKey, setSyncKey] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncing, setSyncing] = useState(false);

  // Restore the last-viewed settings from localStorage when the page is opened
  // with no query string (a bookmark-free visit), so filters/zoom/scale persist
  // across sessions instead of resetting every time. An explicit URL (a shared
  // link, browser back/forward) always wins over the stored snapshot.
  useEffect(() => {
    if (params.toString() !== '') return;
    const stored = safeReadStorage(SETTINGS_STORAGE_KEY);
    if (!stored) return;
    setParams(new URLSearchParams(stored), { replace: true });
    // Restore once, on mount only — subsequent param changes are the user
    // driving the page, not something to overwrite from storage again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const query = params.toString();
    if (query) safeWriteStorage(SETTINGS_STORAGE_KEY, query);
  }, [params]);

  const xMinParam = params.get('xMin');
  const xMaxParam = params.get('xMax');
  const yMinParam = params.get('yMin');
  const yMaxParam = params.get('yMax');

  const parsedXMin = xMinParam !== null && xMinParam !== '' && Number.isFinite(Number(xMinParam)) ? Number(xMinParam) : null;
  const parsedXMax = xMaxParam !== null && xMaxParam !== '' && Number.isFinite(Number(xMaxParam)) ? Number(xMaxParam) : null;
  const parsedYMin = yMinParam !== null && yMinParam !== '' && Number.isFinite(Number(yMinParam)) ? Number(yMinParam) : null;
  const parsedYMax = yMaxParam !== null && yMaxParam !== '' && Number.isFinite(Number(yMaxParam)) ? Number(yMaxParam) : null;

  const isZoomed = parsedXMin !== null || parsedXMax !== null || parsedYMin !== null || parsedYMax !== null;

  const [inputXMin, setInputXMin] = useState(xMinParam ?? '');
  const [inputXMax, setInputXMax] = useState(xMaxParam ?? '');
  const [inputYMin, setInputYMin] = useState(yMinParam ?? '');
  const [inputYMax, setInputYMax] = useState(yMaxParam ?? '');
  const [showAxisInputs, setShowAxisInputs] = useState(false);

  const scrollContainerRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  useEffect(() => {
    setInputXMin(xMinParam ?? '');
    setInputXMax(xMaxParam ?? '');
    setInputYMin(yMinParam ?? '');
    setInputYMax(yMaxParam ?? '');
  }, [xMinParam, xMaxParam, yMinParam, yMaxParam]);

  const load = useCallback(() => getModelComparison({ silent: true }), []);

  const showEstimates = params.get('estimates') !== '0';
  // Estimating costs walks the whole catalog, and the model filter input below
  // re-renders on every keystroke — memoize so typing doesn't redo the pass.
  const estimatedRows = useMemo(() => {
    const observations = catalog?.observations || [];
    return showEstimates ? withEstimatedCosts(observations) : observations;
  }, [catalog, showEstimates]);
  // Models the user's own providers can dispatch. Everything else in the index
  // is available behind "All models" but is not what the page opens on.
  const availableSet = useMemo(() => new Set([
    ...(catalog?.availableModels || []),
    // Keep executable endpoint IDs as well as normalized public model references.
    ...(catalog?.inventory || []).flatMap(provider => provider.models.flatMap(({ model }) => model.startsWith('opencode/') ? [model, model.slice('opencode/'.length)] : [model])),
  ]), [catalog]);

  useEffect(() => {
    let active = true;
    load()
      .then(data => {
        if (active) setCatalog(data);
      })
      .catch(err => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const changeParams = updates =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(updates)) {
          if (value !== null && value !== undefined && value !== '') {
            next.set(key, String(value));
          } else {
            next.delete(key);
          }
        }
        return next;
      },
      { replace: true }
    );

  const changeParam = (key, value) => changeParams({ [key]: value });

  const toggle = (key, value) =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        const values = new Set(next.getAll(key));
        if (values.has(value)) values.delete(value);
        else values.add(value);
        next.delete(key);
        for (const item of values) next.append(key, item);
        return next;
      },
      { replace: true }
    );

  const setAllHidden = (key, valuesToHide) =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        next.delete(key);
        for (const val of valuesToHide) next.append(key, val);
        return next;
      },
      { replace: true }
    );

  const refreshView = () => {
    setBusy(true);
    setError('');
    load()
      .then(setCatalog)
      .catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };

  const discover = providerId => {
    setBusy(true);
    setError('');
    discoverComparisonModels(providerId, { silent: true })
      .then(result => {
        setCatalog(previous => ({
          ...previous,
          inventory: previous.inventory.map(provider =>
            provider.id === providerId ? { ...provider, models: result.models } : provider
          ),
        }));
      })
      .catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };

  const importFile = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 2000000) {
      setError('Catalog file must be smaller than 2 MB.');
      return;
    }
    setBusy(true);
    setError('');
    file
      .text()
      .then(JSON.parse)
      .then(data => importModelComparison(data, { silent: true }))
      .then(data => setCatalog(previous => ({ ...previous, ...data })))
      .catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };

  const handleSyncAA = () => {
    if (!syncKey.trim()) {
      setSyncError('Please enter an Artificial Analysis API key.');
      return;
    }
    setSyncing(true);
    setSyncError('');
    setSyncStatus('Connecting to Artificial Analysis and syncing models…');
    syncArtificialAnalysis({ apiKey: syncKey.trim() }, { silent: true })
      .then(res => {
        setSyncStatus(`Sync successful! Updated ${res.observations} models (${res.total} total).`);
        refreshView();
      })
      .catch(err => {
        setSyncError(err.message || 'Sync failed.');
        setSyncStatus('');
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  if (!catalog) {
    return (
      <div role={error ? 'alert' : 'status'} className="p-6 text-sm text-port-text-muted">
        {error || 'Loading comparison data…'}
        {error && (
          <button
            onClick={refreshView}
            disabled={busy}
            className="ml-3 px-3 py-1 bg-port-card border border-port-border rounded-lg"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const benchmarks = [...new Set(catalog.observations.map(row => row.benchmark))].sort();
  const benchmark = benchmarks.includes(params.get('benchmark'))
    ? params.get('benchmark')
    : [...new Set(catalog.observations.filter(row => row.quality).map(row => row.benchmark))].sort().at(-1) || benchmarks.at(-1);
  const mode = params.get('cost') === 'scenario' ? 'scenario' : 'benchmark';
  const showLines = params.get('lines') !== '0';
  const lineStyle = params.get('lineStyle') || 'dotted';
  const showLabels = params.get('labels') === '1' || !params.has('labels');
  const xAxis = Object.hasOwn(AXES, params.get('xAxis')) ? params.get('xAxis') : 'cost';
  const yAxis = Object.hasOwn(AXES, params.get('yAxis')) ? params.get('yAxis') : 'quality';
  const changeAxis = (key, value) => changeParams({ [key]: value, xMin: null, xMax: null, yMin: null, yMax: null, scale: 'linear' });
  // Cost spans four orders of magnitude across the catalog, so a linear axis
  // stacks every affordable model on the y-axis. Log is the readable default.
  const scale = params.get('scale') === 'log' || (!params.has('scale') && xAxis === 'cost') ? 'log' : 'linear';
  const showAllModels = params.get('allModels') === '1' || availableSet.size === 0;
  const stretch = Math.min(4, Math.max(1, parseFloat(params.get('stretch')) || 1));
  const chartHeight = Math.min(1000, Math.max(380, parseInt(params.get('height'), 10) || 480));


  const handleMouseDown = e => {
    if (stretch <= 1 || !scrollContainerRef.current) return;
    if (e.target.closest('button, input, select, a, [role="button"]')) return;
    setIsDragging(true);
    setStartX(e.pageX - scrollContainerRef.current.offsetLeft);
    setScrollLeft(scrollContainerRef.current.scrollLeft);
  };

  const handleMouseMove = e => {
    if (!isDragging || !scrollContainerRef.current) return;
    e.preventDefault();
    const x = e.pageX - scrollContainerRef.current.offsetLeft;
    const walk = x - startX;
    scrollContainerRef.current.scrollLeft = scrollLeft - walk;
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Scope once, then derive every list from the scoped rows — so the provider
  // and effort pills can't offer values that have nothing left to plot.
  const scoped = showAllModels ? estimatedRows : estimatedRows.filter(row => availableSet.has(row.model));
  const models = [...new Set(scoped.map(row => row.model))].sort();
  const providers = [...new Set(scoped.map(row => row.provider))].sort();
  const efforts = [...new Set(scoped.map(row => row.effort))].sort();

  const hidden = {
    provider: new Set(params.getAll('hideProvider')),
    model: new Set(params.getAll('hideModel')),
    effort: new Set(params.getAll('hideEffort')),
  };
  const visible = scoped.filter(
    row =>
      (row.benchmark === benchmark || row.benchmark === 'Unbenchmarked (pricing only)') &&
      !hidden.provider.has(row.provider) &&
      !hidden.model.has(row.model) &&
      !hidden.effort.has(row.effort)
  );

  const rows = visible.map(row => {
    const cost =
      mode === 'benchmark'
        ? (row.costPerTask?.value ?? row.estimatedCostPerTask?.value)
        : row.billing === 'api' &&
            (scenario.input === 0 || row.inputPerMillion) &&
            (scenario.output === 0 || row.outputPerMillion) &&
            (scenario.reasoning === 0 || row.reasoningPerMillion)
          ? (scenario.input * (row.inputPerMillion?.value || 0) +
              scenario.output * (row.outputPerMillion?.value || 0) +
              scenario.reasoning * (row.reasoningPerMillion?.value || 0)) /
            1000000
          : null;
    const displayName = getModelDisplayName(row);
    return {
      ...row,
      displayName,
      cost,
      x: xAxis === 'cost' ? cost : row[xAxis]?.value,
      y: yAxis === 'cost' ? cost : row[yAxis]?.value,
      costEstimated: mode === 'benchmark' && row.costEstimated === true,
      chartCostEstimated: mode === 'benchmark' && (xAxis === 'cost' || yAxis === 'cost') && row.costEstimated === true,
      label: `${row.model} (${row.effort})${row.responseSeconds ? ` · ${row.responseSeconds.value}s` : ''}`,
    };
  });

  const plotted = rows.filter(row => Number.isFinite(row.x) && Number.isFinite(row.y) && (scale !== 'log' || row.x > 0));

  const xs = plotted.map(r => r.x).filter(x => Number.isFinite(x) && (scale !== 'log' || x > 0));
  const ys = plotted.map(r => r.y).filter(y => Number.isFinite(y));
  const dataBounds = {
    xMin: xs.length ? Math.min(...xs) : 0.01,
    xMax: xs.length ? Math.max(...xs) : 10,
    yMin: ys.length ? Math.min(...ys) : 0,
    yMax: ys.length ? Math.max(...ys) : 100,
  };

  const visibleInZoomCount = !isZoomed
    ? plotted.length
    : plotted.filter(row => {
        if (parsedXMin !== null && row.x < parsedXMin) return false;
        if (parsedXMax !== null && row.x > parsedXMax) return false;
        if (parsedYMin !== null && row.y < parsedYMin) return false;
        if (parsedYMax !== null && row.y > parsedYMax) return false;
        return true;
      }).length;

  const handleZoomIn = () => {
    if (!plotted.length) return;
    const currentXMin = parsedXMin ?? (scale === 'log' ? dataBounds.xMin : 0);
    const currentXMax = parsedXMax ?? dataBounds.xMax;
    const currentYMin = parsedYMin ?? dataBounds.yMin;
    const currentYMax = parsedYMax ?? dataBounds.yMax;

    let newXMin;
    let newXMax;
    if (scale === 'log') {
      const logMin = Math.log10(Math.max(1e-4, currentXMin));
      const logMax = Math.log10(Math.max(1e-3, currentXMax));
      const logCenter = (logMin + logMax) / 2;
      const newSpan = (logMax - logMin) * 0.7;
      newXMin = Number(Math.pow(10, logCenter - newSpan / 2).toPrecision(3));
      newXMax = Number(Math.pow(10, logCenter + newSpan / 2).toPrecision(3));
    } else {
      const span = currentXMax - currentXMin;
      const center = (currentXMin + currentXMax) / 2;
      const newSpan = span * 0.7;
      newXMin = Math.max(0, Number((center - newSpan / 2).toFixed(3)));
      newXMax = Number((center + newSpan / 2).toFixed(3));
    }

    const ySpan = currentYMax - currentYMin;
    const yCenter = (currentYMin + currentYMax) / 2;
    const newYSpan = ySpan * 0.7;
    const newYMin = Math.round(yCenter - newYSpan / 2);
    const newYMax = Math.round(yCenter + newYSpan / 2);

    changeParams({
      xMin: newXMin,
      xMax: newXMax,
      yMin: newYMin,
      yMax: newYMax,
    });
  };

  const handleZoomOut = () => {
    if (!plotted.length) return;
    const currentXMin = parsedXMin ?? (scale === 'log' ? dataBounds.xMin : 0);
    const currentXMax = parsedXMax ?? dataBounds.xMax;
    const currentYMin = parsedYMin ?? dataBounds.yMin;
    const currentYMax = parsedYMax ?? dataBounds.yMax;

    let newXMin;
    let newXMax;
    if (scale === 'log') {
      const logMin = Math.log10(Math.max(1e-4, currentXMin));
      const logMax = Math.log10(Math.max(1e-3, currentXMax));
      const logCenter = (logMin + logMax) / 2;
      const newSpan = (logMax - logMin) * 1.4;
      newXMin = Number(Math.pow(10, logCenter - newSpan / 2).toPrecision(3));
      newXMax = Number(Math.pow(10, logCenter + newSpan / 2).toPrecision(3));
    } else {
      const span = currentXMax - currentXMin;
      const center = (currentXMin + currentXMax) / 2;
      const newSpan = span * 1.4;
      newXMin = Math.max(0, Number((center - newSpan / 2).toFixed(3)));
      newXMax = Number((center + newSpan / 2).toFixed(3));
    }

    const ySpan = currentYMax - currentYMin;
    const yCenter = (currentYMin + currentYMax) / 2;
    const newYSpan = ySpan * 1.4;
    const newYMin = Math.round(yCenter - newYSpan / 2);
    const newYMax = Math.round(yCenter + newYSpan / 2);

    const resetX = newXMin <= dataBounds.xMin && newXMax >= dataBounds.xMax;
    const resetY = newYMin <= dataBounds.yMin && newYMax >= dataBounds.yMax;

    changeParams({
      xMin: resetX ? null : newXMin,
      xMax: resetX ? null : newXMax,
      yMin: resetY ? null : newYMin,
      yMax: resetY ? null : newYMax,
    });
  };

  const handleFitVisible = () => {
    if (!plotted.length) return;
    const xs = plotted.map(r => r.x).filter(x => Number.isFinite(x) && (scale !== 'log' || x > 0));
    const ys = plotted.map(r => r.y).filter(y => Number.isFinite(y));
    if (!xs.length || !ys.length) return;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    let fitXMin;
    let fitXMax;
    if (scale === 'log') {
      fitXMin = Number((minX * 0.9).toPrecision(2));
      fitXMax = Number((maxX * 1.1).toPrecision(2));
    } else {
      fitXMin = Math.max(0, Number((minX * 0.9).toFixed(3)));
      fitXMax = Math.max(fitXMin + 0.001, Number((maxX * 1.05).toFixed(3)));
    }
    const fitYMin = Math.max(0, Math.floor(minY - 2));
    const fitYMax = Math.ceil(maxY + 2);

    changeParams({
      xMin: fitXMin,
      xMax: fitXMax,
      yMin: fitYMin,
      yMax: fitYMax,
    });
  };

  const handleResetZoom = () => {
    changeParams({
      xMin: null,
      xMax: null,
      yMin: null,
      yMax: null,
    });
  };

  const handleApplyCustomBounds = e => {
    if (e) e.preventDefault();
    const xMinNum = inputXMin.trim() !== '' ? Number(inputXMin) : null;
    const xMaxNum = inputXMax.trim() !== '' ? Number(inputXMax) : null;
    const yMinNum = inputYMin.trim() !== '' ? Number(inputYMin) : null;
    const yMaxNum = inputYMax.trim() !== '' ? Number(inputYMax) : null;

    changeParams({
      xMin: xMinNum !== null && !Number.isNaN(xMinNum) ? xMinNum : null,
      xMax: xMaxNum !== null && !Number.isNaN(xMaxNum) ? xMaxNum : null,
      yMin: yMinNum !== null && !Number.isNaN(yMinNum) ? yMinNum : null,
      yMax: yMaxNum !== null && !Number.isNaN(yMaxNum) ? yMaxNum : null,
    });
  };

  // Count models that have 2 or more effort points plotted
  let estimatedCount = 0;
  const multiEffortModelCounts = new Map();
  for (const row of plotted) {
    if (row.chartCostEstimated) estimatedCount += 1;
    multiEffortModelCounts.set(row.model, (multiEffortModelCounts.get(row.model) || 0) + 1);
  }
  const reasoningCurveModels = [...multiEffortModelCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .map(([model]) => model);

  // Filter models for pill toggle display
  const filteredDisplayModels = models.filter(m =>
    !modelSearch || m.toLowerCase().includes(modelSearch.toLowerCase())
  );

  const selectAllModels = () => {
    setAllHidden('hideModel', []);
  };

  const selectReasoningOnly = () => {
    // Keyed on the models that actually PLOT a curve — the same set the button's
    // count names. Counting catalog rows instead would leave models selected
    // that have two efforts but no plottable cost at either.
    setAllHidden('hideModel', models.filter(model => !reasoningCurveModels.includes(model)));
  };

  const clearAllModels = () => {
    setAllHidden('hideModel', models);
  };

  return (
    <div className="space-y-5 min-w-0">
      {/* Header — one compact row: the chart is the page, so the chrome above it
          stays under a single line of text on desktop and never pushes the plot
          below the fold. */}
      <div className="flex flex-wrap justify-between gap-3 items-center">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ChartScatter size={18} aria-hidden="true" className="shrink-0 text-port-accent-text" />
            Intelligence vs. cost per task
          </h2>
          <p className="text-xs text-port-text-muted mt-0.5">
            Artificial Analysis Intelligence Index against cost per task; labels add end-to-end response time, lines connect reasoning efforts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-port-card border border-port-border rounded-lg hover:border-port-accent transition-colors"
            onClick={() => setSyncModalOpen(true)}
          >
            <CloudDownload size={14} aria-hidden="true" className="text-port-accent-text" />
            Sync from Artificial Analysis
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-port-card border border-port-border rounded-lg hover:border-port-accent transition-colors"
            onClick={() => changeParam('research', params.get('research') === '1' ? '' : '1')}
            aria-expanded={params.get('research') === '1'}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Research & schedule
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-port-card border border-port-border rounded-lg hover:border-port-accent disabled:opacity-50 transition-colors"
            disabled={busy}
            onClick={refreshView}
          >
            <RefreshCw size={14} aria-hidden="true" className={busy ? 'animate-spin' : ''} />
            Reload data
          </button>
        </div>
      </div>

      {params.get('research') === '1' && <ComparisonResearch />}
      {error && <p role="alert" className="text-port-error">{error}</p>}

      {/* Sync Modal */}
      {/* Modal owns only the backdrop and the panel box; the surface and heading
          are the caller's. Without them the dialog renders transparent. */}
      <Modal
        open={syncModalOpen}
        onClose={() => setSyncModalOpen(false)}
        size="sm"
        ariaLabelledBy="aa-sync-title"
      >
        <div className="bg-port-card border border-port-border rounded-xl shadow-2xl p-5 space-y-4">
          <h3 id="aa-sync-title" className="text-base font-semibold tracking-tight">
            Sync Artificial Analysis data
          </h3>
          <p className="text-xs text-port-text-muted leading-relaxed">
            Fetch the latest benchmark evaluations, pricing, response times, and reasoning effort measurements from the
            Artificial Analysis Free API.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="aa-api-key" className="text-xs font-medium text-port-text-muted">
              Artificial Analysis API Key
            </label>
            <input
              id="aa-api-key"
              type="password"
              placeholder="aa_..."
              aria-label="Artificial Analysis API Key"
              className="w-full bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm font-mono"
              value={syncKey}
              onChange={e => setSyncKey(e.target.value)}
              disabled={syncing}
            />
          </div>
          {syncStatus && <p className="text-xs text-port-accent-text">{syncStatus}</p>}
          {syncError && <p className="text-xs text-port-error">{syncError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm border border-port-border rounded-lg hover:bg-port-bg"
              onClick={() => setSyncModalOpen(false)}
              disabled={syncing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="px-4 py-1.5 text-sm bg-port-accent text-port-on-accent rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
              onClick={handleSyncAA}
              disabled={syncing || !syncKey.trim()}
            >
              {syncing ? 'Syncing…' : 'Start Sync'}
            </button>
          </div>
        </div>
      </Modal>

      <div className="flex flex-wrap gap-4">
        {[["xAxis", "X axis", xAxis], ["yAxis", "Y axis", yAxis]].map(([key, label, value]) => (
          <label key={key} htmlFor={`comparison-${key}`} className="text-sm">
            {label}
            <select id={`comparison-${key}`} value={value} onChange={event => changeAxis(key, event.target.value)}
              className="block max-w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-2">
              {Object.entries(AXES).map(([id, axis]) => <option key={id} value={id}>{axis.label}</option>)}
            </select>
          </label>
        ))}
      </div>

      {/* Primary Chart Controls Bar */}
      <div className="flex flex-wrap gap-4 items-end bg-port-card border border-port-border rounded-2xl p-4">
        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-benchmark">
          Benchmark<br />
          <select
            id="comparison-benchmark"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={benchmark}
            onChange={e => changeParam('benchmark', e.target.value)}
          >
            {benchmarks.map(value => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-cost">
          Cost basis<br />
          <select
            id="comparison-cost"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={mode}
            onChange={e => changeParam('cost', e.target.value)}
          >
            <option value="benchmark">Published benchmark cost / task</option>
            <option value="scenario">My token workload estimate</option>
          </select>
        </label>

        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-scale">
          X-axis scale<br />
          <select
            id="comparison-scale"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={scale}
            onChange={e => changeParams({ scale: e.target.value, xMin: null, xMax: null, yMin: null, yMax: null })}
          >
            <option value="linear">Linear scale</option>
            <option value="log">Logarithmic scale</option>
          </select>
        </label>

        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-line-style">
          Line style<br />
          <select
            id="comparison-line-style"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={lineStyle}
            onChange={e => changeParam('lineStyle', e.target.value)}
            disabled={!showLines}
          >
            <option value="dotted">Dotted</option>
            <option value="dashed">Dashed</option>
            <option value="solid">Solid</option>
          </select>
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-lines">
          <input
            id="comparison-lines"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showLines}
            onChange={e => changeParam('lines', e.target.checked ? '1' : '0')}
          />
          Connect effort lines
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-labels">
          <input
            id="comparison-labels"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showLabels}
            onChange={e => changeParam('labels', e.target.checked ? '1' : '0')}
          />
          Point labels
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-estimates">
          <input
            id="comparison-estimates"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showEstimates}
            onChange={e => changeParam('estimates', e.target.checked ? '1' : '0')}
          />
          Estimate unpublished costs
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-all-models">
          <input
            id="comparison-all-models"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showAllModels}
            disabled={availableSet.size === 0}
            onChange={e => changeParam('allModels', e.target.checked ? '1' : '0')}
          />
          All models (not just yours)
        </label>
      </div>

      {/* Scenario Token Inputs */}
      {mode === 'scenario' && (
        <div className="bg-port-card border border-port-border p-4 rounded-2xl space-y-3">
          <div className="flex flex-wrap gap-3">
            {[
              ['input', 'Uncached input tokens'],
              ['output', 'Answer tokens'],
              ['reasoning', 'Reasoning tokens'],
              ['tasks', 'Number of tasks'],
            ].map(([key, label]) => (
              <label key={key} htmlFor={`comparison-${key}`}>
                {label}
                <br />
                <input
                  id={`comparison-${key}`}
                  type="number"
                  min="0"
                  max="1000000000"
                  className="w-36 bg-port-bg border border-port-border p-2 rounded mt-1"
                  value={scenario[key]}
                  onChange={e =>
                    setScenario(previous => ({
                      ...previous,
                      [key]: Math.max(0, Math.min(1e9, Number(e.target.value) || 0)),
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <p className="text-sm text-port-text-muted">
            Estimate uses the entered tokens and published rates. Quality remains the published benchmark score; it does not
            predict quality at this token budget. Include reasoning tokens when applicable. Cache, batch, context-tier
            discounts and taxes are excluded.
          </p>
        </div>
      )}

      {/* Chart Card */}
      <div className="bg-port-card border border-port-border rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-6 pt-5 pb-4 border-b border-port-border space-y-3">
          <div className="flex flex-wrap justify-between items-start gap-3">
            <div>
              <h3 className="font-semibold text-lg tracking-tight">{AXES[yAxis].label} vs. {AXES[xAxis].label}</h3>
              <p className="text-xs text-port-text-muted mt-0.5">{benchmark}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-port-bg border border-port-border px-3 py-1 text-xs text-port-text-muted">
                <ArrowUpRight size={14} aria-hidden="true" className="-rotate-90 text-port-accent-text" />
                Prefer {AXES[xAxis].prefer} X, {AXES[yAxis].prefer} Y
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-port-text-muted">
            <span aria-live="polite">
              {plotted.length} plotted{isZoomed ? ` (${visibleInZoomCount} in zoom)` : ''} · {rows.length - plotted.length} missing selected metrics or outside log scale
              {reasoningCurveModels.length > 0 ? ` · ${reasoningCurveModels.length} reasoning curves` : ''}
              {estimatedCount > 0 ? ` · ${estimatedCount} estimated cost` : ''}
            </span>

            {/* Quick selection actions */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={selectAllModels}
                className="px-2 py-0.5 rounded border border-port-border hover:border-port-accent hover:text-port-text transition-colors"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={selectReasoningOnly}
                className="px-2 py-0.5 rounded border border-port-border hover:border-port-accent hover:text-port-text transition-colors"
              >
                Reasoning curves ({reasoningCurveModels.length})
              </button>
              <button
                type="button"
                onClick={clearAllModels}
                className="px-2 py-0.5 rounded border border-port-border hover:border-port-accent hover:text-port-text transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Model Search & Toggle Filter */}
          <div className="space-y-2 pt-1">
            <div className="relative max-w-xs">
              <Search size={13} className="absolute left-2.5 top-2.5 text-port-text-muted" />
              <input
                id="model-filter-search"
                type="text"
                aria-label="Filter models below"
                placeholder="Filter models below…"
                value={modelSearch}
                onChange={e => setModelSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg"
              />
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pt-1" aria-label="Toggle chart models">
              {filteredDisplayModels.map((model, index) => {
                const colorIndex = models.indexOf(model);
                const color = COLORS[colorIndex >= 0 ? colorIndex % COLORS.length : index % COLORS.length];
                const selected = !params.getAll('hideModel').includes(model);
                const isCurve = reasoningCurveModels.includes(model);
                return (
                  <button
                    key={model}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Toggle ${model}`}
                    onClick={() => toggle('hideModel', model)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors hover:border-port-accent ${
                      selected
                        ? 'bg-port-bg border-port-border text-port-text'
                        : 'border-transparent text-port-text-muted opacity-50'
                    }`}
                  >
                    <span
                      className="size-3 rounded-full flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: selected ? color : 'transparent',
                        border: `1.5px solid ${color}`,
                      }}
                    >
                      {selected && <Check size={8} color="#ffffff" aria-hidden="true" />}
                    </span>
                    <span className="font-mono text-[11px]">{model}</span>
                    {isCurve && <span className="text-[10px] text-port-text-muted">({multiEffortModelCounts.get(model)})</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Chart Scale, Zoom & Stretch Controls Bar */}
        <div className="px-4 sm:px-6 py-3 bg-port-bg/40 border-b border-port-border space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left: Stretch Width & Height */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-port-text-muted">
                <MoveHorizontal size={14} className="text-port-accent-text" aria-hidden="true" />
                <span>Stretch width:</span>
                <div className="inline-flex rounded-lg border border-port-border bg-port-bg p-0.5" role="group" aria-label="Chart stretch width">
                  {[
                    { label: '1×', value: '1' },
                    { label: '1.5×', value: '1.5' },
                    { label: '2×', value: '2' },
                    { label: '3×', value: '3' },
                  ].map(opt => {
                    const active = (opt.value === '1' && stretch === 1) || String(stretch) === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => changeParam('stretch', opt.value === '1' ? null : opt.value)}
                        aria-pressed={active}
                        className={`px-2 py-0.5 rounded text-xs transition-colors ${
                          active
                            ? 'bg-port-accent text-port-on-accent font-medium shadow-xs'
                            : 'text-port-text-muted hover:text-port-text'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-xs font-medium text-port-text-muted">
                <span>Height:</span>
                <div className="inline-flex rounded-lg border border-port-border bg-port-bg p-0.5" role="group" aria-label="Chart height">
                  {[
                    { label: '480px', value: 480 },
                    { label: '600px', value: 600 },
                    { label: '720px', value: 720 },
                  ].map(opt => {
                    const active = chartHeight === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => changeParam('height', opt.value === 480 ? null : opt.value)}
                        aria-pressed={active}
                        className={`px-2 py-0.5 rounded text-xs transition-colors ${
                          active
                            ? 'bg-port-accent text-port-on-accent font-medium shadow-xs'
                            : 'text-port-text-muted hover:text-port-text'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right: Zoom In, Zoom Out, Fit Visible, Reset, Scale Axes Toggle */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={!plotted.length}
                title="Zoom in on both axes"
                aria-label="Zoom in"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-border bg-port-bg text-xs hover:border-port-accent hover:text-port-text disabled:opacity-50 transition-colors"
              >
                <ZoomIn size={13} aria-hidden="true" />
                <span>Zoom in</span>
              </button>

              <button
                type="button"
                onClick={handleZoomOut}
                disabled={!plotted.length}
                title="Zoom out on both axes"
                aria-label="Zoom out"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-border bg-port-bg text-xs hover:border-port-accent hover:text-port-text disabled:opacity-50 transition-colors"
              >
                <ZoomOut size={13} aria-hidden="true" />
                <span>Zoom out</span>
              </button>

              <button
                type="button"
                onClick={handleFitVisible}
                disabled={!plotted.length}
                title="Fit axes tightly to visible models"
                aria-label="Fit visible"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-border bg-port-bg text-xs hover:border-port-accent hover:text-port-text disabled:opacity-50 transition-colors"
              >
                <Focus size={13} aria-hidden="true" />
                <span>Fit visible</span>
              </button>

              {isZoomed && (
                <button
                  type="button"
                  onClick={handleResetZoom}
                  title="Reset axis zoom to auto"
                  aria-label="Reset zoom"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-accent/50 bg-port-accent/10 text-port-accent-text text-xs hover:bg-port-accent/20 transition-colors"
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  <span>Reset zoom</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowAxisInputs(!showAxisInputs)}
                aria-expanded={showAxisInputs}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs transition-colors ${
                  showAxisInputs || isZoomed
                    ? 'border-port-accent text-port-accent-text bg-port-accent/10'
                    : 'border-port-border bg-port-bg text-port-text-muted hover:border-port-accent hover:text-port-text'
                }`}
              >
                <SlidersHorizontal size={13} aria-hidden="true" />
                <span>Scale axes</span>
                {isZoomed && (
                  <span className="size-1.5 rounded-full bg-port-accent" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {/* Expandable Manual Axis Scale Inputs */}
          {showAxisInputs && (
            <form
              onSubmit={handleApplyCustomBounds}
              className="flex flex-wrap items-end gap-3 pt-2 border-t border-port-border text-xs"
            >
              {/* Cost X Axis Bounds */}
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-port-text">{AXES[xAxis].label}:</span>
                <label className="flex items-center gap-1 text-port-text-muted">
                  <span>Min</span>
                  <input
                    type="number"
                    step="any"
                    min={scale === 'log' ? '0.0001' : '0'}
                    placeholder="Auto"
                    aria-label={`Minimum ${AXES[xAxis].short}`}
                    value={inputXMin}
                    onChange={e => setInputXMin(e.target.value)}
                    className="w-20 px-2 py-1 bg-port-bg border border-port-border rounded text-port-text text-xs font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 text-port-text-muted">
                  <span>Max</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="Auto"
                    aria-label={`Maximum ${AXES[xAxis].short}`}
                    value={inputXMax}
                    onChange={e => setInputXMax(e.target.value)}
                    className="w-20 px-2 py-1 bg-port-bg border border-port-border rounded text-port-text text-xs font-mono"
                  />
                </label>
              </div>

              {/* Quality Y Axis Bounds */}
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-port-text">{AXES[yAxis].label}:</span>
                <label className="flex items-center gap-1 text-port-text-muted">
                  <span>Min</span>
                  <input
                    type="number"
                    step="any"
                    placeholder="Auto"
                    aria-label={`Minimum ${AXES[yAxis].short}`}
                    value={inputYMin}
                    onChange={e => setInputYMin(e.target.value)}
                    className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-port-text text-xs font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 text-port-text-muted">
                  <span>Max</span>
                  <input
                    type="number"
                    step="any"
                    placeholder="Auto"
                    aria-label={`Maximum ${AXES[yAxis].short}`}
                    value={inputYMax}
                    onChange={e => setInputYMax(e.target.value)}
                    className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-port-text text-xs font-mono"
                  />
                </label>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="submit"
                  className="px-3 py-1 bg-port-accent text-port-on-accent rounded text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  Apply range
                </button>
                {isZoomed && (
                  <button
                    type="button"
                    onClick={() => {
                      setInputXMin('');
                      setInputXMax('');
                      setInputYMin('');
                      setInputYMax('');
                      handleResetZoom();
                    }}
                    className="px-2.5 py-1 border border-port-border rounded text-xs text-port-text-muted hover:text-port-text transition-colors"
                  >
                    Clear range
                  </button>
                )}
              </div>
            </form>
          )}
        </div>

        {/* Chart Area */}
        {plotted.length ? (
          <div className="relative">
            {stretch > 1 && (
              <div className="flex items-center justify-between px-4 py-1.5 text-xs text-port-text-muted bg-port-bg/60 border-b border-port-border">
                <span className="inline-flex items-center gap-1.5 text-[11px]">
                  <MoveHorizontal size={13} aria-hidden="true" className="text-port-accent-text shrink-0" />
                  Chart stretched {stretch}× — scroll or drag horizontally to explore
                </span>
                <span className="font-mono text-[10px]">
                  {visibleInZoomCount} of {plotted.length} points visible
                </span>
              </div>
            )}
            <div
              ref={scrollContainerRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ height: `${chartHeight}px` }}
              className={`overflow-x-auto px-1 sm:px-4 pt-4 scrollbar-thin ${
                stretch > 1 ? (isDragging ? 'cursor-grabbing select-none' : 'cursor-grab') : ''
              }`}
              role="img"
              aria-label={`${AXES[yAxis].label} versus ${AXES[xAxis].label}. Exact values and source links are in the table below.`}
            >
              <div
                style={{
                  width: stretch > 1 ? `${Math.round(stretch * 100)}%` : '100%',
                  minWidth: '100%',
                  height: '100%',
                }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 32, right: 24, bottom: 36, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 5" stroke="rgb(var(--port-border))" vertical={false} />
                    <XAxis
                      tick={{ fill: 'rgb(var(--port-text-muted))', fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: 'rgb(var(--port-border))' }}
                      type="number"
                      dataKey="x"
                      name={AXES[xAxis].label}
                      scale={scale === 'log' ? 'log' : 'linear'}
                      domain={
                        isZoomed
                          ? [
                              parsedXMin !== null
                                ? parsedXMin
                                : scale === 'log'
                                  ? 'auto'
                                  : 0,
                              parsedXMax !== null ? parsedXMax : 'auto',
                            ]
                          : scale === 'log'
                            ? ['auto', 'auto']
                            : [0, 'auto']
                      }
                      allowDataOverflow={isZoomed}
                      tickFormatter={value => `${AXES[xAxis].money ? '$' : ''}${Number(value.toPrecision(4))}`}
                      label={{
                        value: `${AXES[xAxis].label} — ${scale.toUpperCase()} SCALE${isZoomed ? ' (ZOOMED)' : ''}`,
                        position: 'bottom',
                        fill: 'rgb(var(--port-text-muted))',
                        fontSize: 12,
                        offset: 10,
                      }}
                    />
                    <YAxis
                      tick={{ fill: 'rgb(var(--port-text-muted))', fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: 'rgb(var(--port-border))' }}
                      type="number"
                      dataKey="y"
                      name={AXES[yAxis].label}
                      domain={
                        isZoomed
                          ? [
                              parsedYMin !== null ? parsedYMin : 'auto',
                              parsedYMax !== null ? parsedYMax : 'auto',
                            ]
                          : ['auto', 'auto']
                      }
                      allowDataOverflow={isZoomed}
                      width={55}
                      label={{
                        value: AXES[yAxis].label,
                        angle: -90,
                        position: 'insideLeft',
                        fill: 'rgb(var(--port-text-muted))',
                        fontSize: 12,
                      }}
                    />
                    <Tooltip
                      cursor={{ strokeDasharray: '4 4', stroke: 'rgb(var(--port-text-muted))' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.[0]) return null;
                        const item = payload[0].payload;
                        if (
                          (parsedXMin !== null && item.x < parsedXMin) ||
                          (parsedXMax !== null && item.x > parsedXMax) ||
                          (parsedYMin !== null && item.y < parsedYMin) ||
                          (parsedYMax !== null && item.y > parsedYMax)
                        ) {
                          return null;
                        }
                        return (
                          <div className="bg-port-card border border-port-border rounded-xl shadow-xl p-3.5 text-xs max-w-72 space-y-1.5 z-50">
                            <div className="flex items-center justify-between gap-2 border-b border-port-border pb-1.5">
                              <span className="font-semibold text-sm text-port-text truncate">{item.displayName || item.model}</span>
                              <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px] uppercase font-mono text-port-accent-text">
                                {item.effort}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-port-text-muted">
                              <div>
                                Provider: <span className="text-port-text font-medium">{item.provider}</span>
                              </div>
                              <div>
                                USD / task:{' '}
                                <span className="text-port-text font-semibold">{Number.isFinite(item.cost) ? `$${item.cost.toFixed(4)}` : 'Unknown'}</span>
                                {item.costEstimated && <span className="text-port-text-muted"> est.</span>}
                              </div>
                              <div>
                                Benchmark score: <span className="text-port-accent-text font-bold">{item.quality?.value ?? 'Unknown'}</span>
                              </div>
                              {item.responseSeconds && (
                                <div>
                                  E2E Latency: <span className="text-port-text font-medium">{item.responseSeconds.value}s</span>
                                </div>
                              )}
                              {item.tokensPerSecond && (
                                <div>
                                  Speed: <span className="text-port-text font-medium">{item.tokensPerSecond.value} t/s</span>
                                </div>
                              )}
                              {item.outputPerMillion && (
                                <div>Out: <span className="text-port-text font-medium">${item.outputPerMillion.value}/1M</span></div>
                              )}
                              {item.inputPerMillion && (
                                <div>
                                  In: <span className="text-port-text font-medium">${item.inputPerMillion.value}/1M</span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }}
                    />
                    {models.map((model, index) => {
                      const modelData = plotted
                        .filter(row => row.model === model)
                        .sort(
                          (a, b) =>
                            (EFFORT_ORDER[a.effort] ?? 99) - (EFFORT_ORDER[b.effort] ?? 99) || (a.x - b.x)
                        );
                      if (!modelData.length) return null;
                      const color = COLORS[index % COLORS.length];
                      const hasLine = showLines && modelData.length > 1;

                      return (
                        <Scatter
                          key={model}
                          name={model}
                          isAnimationActive={false}
                          data={modelData}
                          fill={color}
                          line={
                            hasLine
                              ? {
                                  stroke: color,
                                  strokeDasharray:
                                    lineStyle === 'dotted' ? '3 3' : lineStyle === 'dashed' ? '6 4' : undefined,
                                  strokeWidth: 2,
                                }
                              : false
                          }
                          // A hollow marker means the cost came from the effort-ratio
                          // estimate, not from a published cost per task.
                          shape={({ cx, cy, fill, payload }) => (
                            <g>
                              <circle cx={cx} cy={cy} r={9} fill={fill} fillOpacity={0.16} stroke="none" />
                              <circle
                                cx={cx}
                                cy={cy}
                                r={5}
                                fill={payload?.chartCostEstimated ? 'rgb(var(--port-card))' : fill}
                                stroke={payload?.chartCostEstimated ? fill : 'rgb(var(--port-card))'}
                                strokeWidth={payload?.chartCostEstimated ? 2 : 1.5}
                              />
                            </g>
                          )}
                        >
                          {showLabels && (
                            <LabelList
                              dataKey="label"
                              position="top"
                              content={labelProps => {
                                const { x, y, index: ptIdx } = labelProps;
                                const pt = modelData[ptIdx];
                                if (!pt) return null;
                                if (
                                  (parsedXMin !== null && pt.x < parsedXMin) ||
                                  (parsedXMax !== null && pt.x > parsedXMax) ||
                                  (parsedYMin !== null && pt.y < parsedYMin) ||
                                  (parsedYMax !== null && pt.y > parsedYMax)
                                ) {
                                  return null;
                                }
                                const shortName = pt.displayName || pt.model;
                                const effortLabel = pt.effort && pt.effort !== 'unspecified' ? pt.effort : '';
                                const e2eStr = pt.responseSeconds?.value ? `${pt.responseSeconds.value} s E2E` : '';
                                return (
                                  <g transform={`translate(${x}, ${y - 12})`} className="pointer-events-none select-none">
                                    <text textAnchor="middle" className="text-[10px] fill-port-text font-medium">
                                      {effortLabel ? `${shortName} (${effortLabel})` : shortName}
                                    </text>
                                    {e2eStr && (
                                      <text textAnchor="middle" dy="11" className="text-[9px] fill-port-text-muted">
                                        {e2eStr}
                                      </text>
                                    )}
                                  </g>
                                );
                              }}
                            />
                          )}
                        </Scatter>
                      );
                    })}
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        ) : (
          <p className="py-12 text-center text-port-text-muted">
            No comparable points for these filters. Adjust filters or refresh the research catalog.
          </p>
        )}
        <p className="text-xs leading-relaxed text-port-text-muted border-t border-port-border px-4 sm:px-6 py-4">
          Missing values stay in the evidence table. Log X excludes zero values, including free pricing; choose linear to include them. Higher speed is better; lower response time is better.
          Response-time labels reflect measured source workloads, independent of the intelligence evaluation. Connected lines
          link the same model family across reasoning efforts (ordered from low to max). Hollow markers are estimated costs:
          Artificial Analysis publishes cost per task for only one effort of most models, so the remaining efforts are scaled
          from that model&apos;s published anchor using the effort-cost curve measured across the models that do publish a full
          set. Turn them off with &ldquo;Estimate unpublished costs&rdquo;.
        </p>
      </div>

      {/* Filters Accordion */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary className="cursor-pointer font-medium">Show or hide providers, models & effort</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mt-3">
          {[
            ['Providers', 'hideProvider', providers],
            ['Models', 'hideModel', models],
            ['Effort', 'hideEffort', efforts],
          ].map(([title, key, values]) => (
            <fieldset key={key} className="max-h-48 overflow-auto space-y-1">
              <legend className="font-semibold">{title}</legend>
              {values.map(value => (
                <label htmlFor={`${key}-${encodeURIComponent(value)}`} key={value} className="flex items-center gap-2 py-1">
                  <input
                    id={`${key}-${encodeURIComponent(value)}`}
                    type="checkbox"
                    className="accent-port-accent size-4 shrink-0"
                    checked={!params.getAll(key).includes(value)}
                    onChange={() => toggle(key, value)}
                  />
                  {value}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </details>

      {/* Evidence Table */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary className="cursor-pointer font-semibold">Evidence & sources ({rows.length} configurations)</summary>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <caption className="text-left font-semibold py-2">Evidence and estimates</caption>
            <thead className="text-xs text-port-text-muted bg-port-bg">
              <tr>
                {[
                  'Provider / model / effort',
                  'Quality',
                  'USD / task',
                  'Input / output USD per 1M',
                  'Scenario total',
                  'Response / speed',
                  'Quota',
                  'Sources & freshness',
                ].map(label => (
                  <th className="p-3" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-t border-port-border align-top hover:bg-port-bg/50">
                  <td className="p-3">
                    <strong>
                      {row.provider} · {row.displayName || row.model} ({row.effort})
                    </strong>
                    <p>
                      {row.billing} · {row.configuration}
                    </p>
                    <p className="text-port-text-muted">{row.benchmark} · {row.notes}</p>
                  </td>
                  <td className="p-3">{row.quality?.value ?? 'Unknown'}</td>
                  <td className="p-3">{Number.isFinite(row.cost) ? `$${row.cost.toFixed(4)}` : 'Unknown'}{row.costEstimated ? ' (estimated)' : ''}</td>
                  <td className="p-3">{row.inputPerMillion ? `$${row.inputPerMillion.value}` : 'Unknown'} / {row.outputPerMillion ? `$${row.outputPerMillion.value}` : 'Unknown'}</td>
                  <td className="p-3">
                    {mode === 'scenario' && Number.isFinite(row.cost) ? `$${(row.cost * scenario.tasks).toFixed(2)}` : '—'}
                  </td>
                  <td className="p-3">
                    {row.responseSeconds ? `${row.responseSeconds.value}s E2E` : 'E2E unknown'}
                    <br />
                    {row.tokensPerSecond ? `${row.tokensPerSecond.value} tok/s` : 'Speed unknown'}
                  </td>
                  <td className="p-3">
                    {row.quota
                      ? `${row.quota.unitsPerTask} ${row.quota.unit}/task${mode === 'scenario' ? ` · ${row.quota.unitsPerTask * scenario.tasks} total` : ''}`
                      : 'Unknown'}
                  </td>
                  <td className="p-2 min-w-56">
                    {METRICS.filter(key => row[key]).map(key => (
                      <p key={key} className="mb-2">
                        <a className="text-port-accent-text underline" href={row[key].source.url} target="_blank" rel="noreferrer">
                          {key}
                        </a>{' '}
                        · {row[key].source.retrievedAt.slice(0, 10)}
                        {Date.now() - Date.parse(row[key].source.retrievedAt) > STALE_MS && <strong> · Stale</strong>}
                        <br />
                        <span className="text-port-text-muted">{row[key].source.methodology}</span>
                      </p>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Provider Coverage */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary>Configured provider coverage ({catalog.inventory?.length || 0} providers)</summary>
        <p className="text-sm text-port-text-muted my-2">
          Model-name matches are references only, not measurements of this endpoint. Quantization, local hardware, harnesses
          and billing may differ. Refresh model lists in{' '}
          <Link className="text-port-accent-text underline" to="/models/harnesses">
            Harnesses
          </Link>{' '}
          or{' '}
          <Link className="text-port-accent-text underline" to="/models/llms/library">
            LLMs
          </Link>
          , then reload here.
        </p>
        {catalog.inventory?.map(provider => (
          <div key={provider.id} className="my-3">
            <strong>{provider.name}</strong>
            {provider.canDiscover && (
              <button className="ml-3 underline text-port-accent-text" disabled={busy} onClick={() => discover(provider.id)}>
                Discover current models
              </button>
            )}
            <ul>
              {provider.models.map(({ model, efforts: supported }) => (
                <li key={model}>
                  {model} {supported.length ? `(${supported.join(', ')})` : ''} —{' '}
                  {catalog.observations.some(row => row.model === model)
                    ? 'Public model reference available; endpoint equivalence unverified'
                    : 'Needs research'}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>

      {/* Import Sourced Observations */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary>Import sourced observations</summary>
        <p className="text-sm my-2">
          Import a version 1 catalog following docs/MODEL-COMPARISON.md. Valid observations merge by stable ID; missing or older
          metrics preserve existing evidence.
        </p>
        <label htmlFor="comparison-import">Catalog JSON</label>
        <input
          id="comparison-import"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={importFile}
          className="block my-2"
        />
      </details>

      <p className="text-xs text-port-text-muted">
        Benchmark attribution:{' '}
        <a className="underline" href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">
          Artificial Analysis
        </a>
        . Source-specific methodologies appear above. Entries older than 30 days are marked stale.
      </p>
    </div>
  );
}
