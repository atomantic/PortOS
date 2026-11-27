/** Subprocess limits for Film renders and shot-list jobs. */
const GIB = 1024 ** 3;
export const RENDER_LIMITS = Object.freeze({ wallSeconds: 6 * 60 * 60, memoryBytes: 32 * GIB, diskBytes: 16 * GIB, maxFiles: 200_000 });
export const DESCRIBE_LIMITS = Object.freeze({ wallSeconds: 5 * 60, memoryBytes: 8 * GIB, diskBytes: GIB, maxFiles: 10_000 });
