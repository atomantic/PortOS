// The activity probe reads the same in-flight set the renderer updates at admission and settlement.
export const activeOperations = new Set();
export const getActiveModelOperationCount = () => activeOperations.size;
