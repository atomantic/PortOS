/** Shared Local LLM progress socket envelope. */
import { emitToOperatorsOn } from '../services/socketIo.js'

export const localLlmProgress = (req) => {
  const io = req.app.get('io')
  return (event, message, extra) => emitToOperatorsOn(io, 'localLlm:progress', { event, message, ...extra })
}
