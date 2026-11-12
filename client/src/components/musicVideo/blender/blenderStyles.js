// Shared control classes for the Blender film panels: 44px on touch, compact on a fine pointer.
const control = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-sm disabled:opacity-50 pointer-fine:sm:min-h-0';
export const buttonCls = `${control} border border-port-border bg-port-bg hover:border-port-accent`;
export const primaryCls = `${control} border border-port-accent bg-port-accent text-port-on-accent hover:brightness-110`;
export const inputCls = 'min-h-[44px] w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-port-accent disabled:opacity-50 pointer-fine:sm:min-h-0';
export const labelCls = 'mb-0.5 block text-xs text-port-text-muted';
export const noticeCls = 'rounded border border-port-warning/40 bg-port-warning/10 p-2 text-xs';
