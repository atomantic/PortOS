export default function TopazUpscalePanel({ estimate: { model, changeModel, getQuote, quoting, quoteError, quote } }) {
  return (
    <div className="p-2 border border-port-border rounded space-y-2 text-xs text-gray-400">
      <label htmlFor="topaz-model" className="block">Model</label>
      <select id="topaz-model" value={model} onChange={event => changeModel(event.target.value)} className="bg-port-bg border border-port-border rounded p-1">
        <option value="proteus">Proteus (precision)</option>
        <option value="starlight">Starlight Fast 2 (generative)</option>
      </select>
      {model === 'starlight' && <p className="text-port-warning">Generative enhancement can change details in the video.</p>}
      <p>Delivery target: 1920 × 1080. The full frame is preserved with square-pixel normalization and black padding when needed. The original master stays unchanged.</p>
      <p>Topaz reserves credits when the job starts and says it automatically reloads credits at the plan rate when they run out. Your balance, dollar cost and reload charge are unknown here. Review <a className="underline text-port-accent" href="https://www.topazlabs.com/api" target="_blank" rel="noreferrer">Topaz pricing and terms</a>.</p>
      <p>Configure your key in Settings → Credentials. Canceling locally may not stop remote processing or charges until Topaz confirms cancellation.</p>
      <button type="button" onClick={getQuote} disabled={quoting} className="border border-port-border rounded px-2 py-1.5 disabled:opacity-50">{quoting ? 'Getting estimate…' : 'Get free estimate'}</button>
      {quoteError && <p role="alert" className="text-port-error">{quoteError}</p>}
      {quote && <p role="status">Source {quote.source.resolution.width} × {quote.source.resolution.height}; square-pixel frame {quote.normalized.width} × {quote.normalized.height}; padded to {quote.padding.width} × {quote.padding.height}; target {quote.target.width} × {quote.target.height}. Estimated {quote.credits[0]}–{quote.credits[1]} credits.</p>}
    </div>
  );
}
