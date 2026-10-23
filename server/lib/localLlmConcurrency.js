// Per-endpoint cap on concurrent local-LLM work. Own leaf so CoS slot
// accounting can read it without loading the prompt runner's import graph.
export const LOCAL_LLM_MAX_CONCURRENCY = Math.max(1, Number(process.env.LOCAL_LLM_MAX_CONCURRENCY) || 1);
