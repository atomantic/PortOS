/** Shared Local LLM progress socket envelope. */
export const localLlmProgress = (req) => {
  const io = req.app.get('io')
  return (event, message, extra) => io?.emit('localLlm:progress', { event, message, ...extra })
}
