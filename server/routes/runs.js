/**
 * Create PortOS-specific runs routes
 * Currently just uses toolkit routes directly, but wrapper allows for future extensions
 */
export function createPortOSRunsRoutes(aiToolkit) {
  // For now, just return the toolkit routes directly
  // Future PortOS-specific extensions can be added here
  return aiToolkit.routes.runs;
}
