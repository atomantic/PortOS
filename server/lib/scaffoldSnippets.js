// Inline CORS middleware snippet for generated projects (no cors package dependency)
//
// Shared generated-project source snippets: `CORS_SNIPPET` provides dependency-free Express CORS
// middleware for the Express, PortOS, and Vite scaffold generators.
export const CORS_SNIPPET = `app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});`;
