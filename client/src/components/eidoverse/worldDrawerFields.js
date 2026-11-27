export const fieldClass = 'mt-1 min-h-[42px] w-full rounded-lg border border-port-border bg-port-bg px-3 text-sm text-white focus:border-port-accent focus:outline-none';
export const secondaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg border border-port-border px-3 py-2 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white disabled:cursor-wait disabled:opacity-50';
export const primaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg bg-port-accent px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50';

export const titleCase = (value) => String(value || '')
  .replace(/[-_]/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());
