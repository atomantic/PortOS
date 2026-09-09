import { AlertTriangle, Activity, CheckCircle, XCircle } from 'lucide-react';

export const DEFAULT_HEALTH_THRESHOLDS = {
  memoryWarn: 85,
  memoryCritical: 95,
  diskWarn: 90,
  diskCritical: 98,
  cpuWarn: 75,
  cpuCritical: 100,
};

export const HEALTH_STYLE = {
  healthy: { color: 'text-port-success', bg: 'bg-port-success/10', icon: CheckCircle, label: 'Healthy' },
  warning: { color: 'text-port-warning', bg: 'bg-port-warning/10', icon: AlertTriangle, label: 'Warning' },
  critical: { color: 'text-port-error', bg: 'bg-port-error/10', icon: XCircle, label: 'Critical' },
};

export function resolveHealthThresholds(thresholds = {}) {
  return { ...DEFAULT_HEALTH_THRESHOLDS, ...thresholds };
}

export function pctTone(pct, warn, critical) {
  if (pct >= critical) return 'text-port-error';
  if (pct >= warn) return 'text-port-warning';
  return 'text-port-success';
}

export function barTone(pct, warn, critical) {
  if (pct >= critical) return 'bg-port-error';
  if (pct >= warn) return 'bg-port-warning';
  return 'bg-port-success';
}
