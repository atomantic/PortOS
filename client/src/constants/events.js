// DOM CustomEvent names PortOS dispatches across component trees. Centralized
// so the publisher and listener can't drift on spelling.

export const DASHBOARD_LAYOUT_CHANGED = 'portos:dashboard-layout-changed';
export const INSTANCE_FEATURES_CHANGED = 'portos:instance-features-changed';
export const ACTION_QUEUE_CHANGED = 'portos:action-queue-changed';
