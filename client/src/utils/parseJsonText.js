// Parse user-supplied JSON text, replacing the raw engine SyntaxError with an "Invalid JSON: <reason>" message.
export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
