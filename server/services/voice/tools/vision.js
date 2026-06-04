// Visual-description voice tool (ui_describe_visually): screenshot the active
// tab and describe it with a vision model. For VISUAL content the text-based
// ui_read can't capture — charts, 3D/WebGL views, images, diagrams. Capture
// runs client-side over the live voice widget.

// Visual description — needs a vision model on a screenshot. "what's on this
// chart/graph", "describe this", "what am I looking at", "what does this
// look like". Kept distinct from `ui` (text read) so the LLM can choose
// ui_read vs ui_describe_visually.
export const VISION_INTENT_RE = /\b(chart|graph|diagram|cyber ?city|3d|render(?:ing)?|visualization|picture|image|screenshot)\b|\b(?:what(?:'s| does| am i)?|describe)\b[^.!?\n]{0,30}\b(?:look(?:ing|s)? like|on (?:this|the) (?:chart|graph|screen|map)|visual(?:ly)?)\b/i;

export const VISION_TOOLS = [
  {
    name: 'ui_describe_visually',
    description:
      "Take a screenshot of what the user is currently looking at and describe it using a vision model. Use when the user asks about VISUAL content the text-based ui_read can't capture — \"what's on this chart?\", \"describe this graph\", \"what does the CyberCity look like right now?\", \"what am I looking at?\". For plain text content prefer ui_read; only reach for this when the answer requires SEEING pixels (charts, 3D/WebGL views, images, diagrams). The screenshot is captured client-side (the browser may prompt for screen-capture permission the first time).",
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What the user wants to know about the screen (e.g. "what does this chart show?"). Defaults to a general description.',
        },
      },
    },
    execute: async ({ question } = {}, ctx = {}) => {
      if (typeof ctx.captureScreenshot !== 'function') {
        return {
          ok: false,
          error: 'No screenshot channel',
          summary: "I can't capture the screen right now — this only works through the live voice widget.",
        };
      }
      const prompt = (typeof question === 'string' && question.trim())
        ? `${question.trim()}\n\nAnswer concisely based only on what is visible in this screenshot.`
        : 'Describe what is visible in this screenshot of an app screen, concisely.';
      // Ask the client to capture the active tab. Returns a data URL (base64
      // PNG/JPEG) or null if the user denied / capture failed.
      const dataUrl = await ctx.captureScreenshot().catch(() => null);
      if (!dataUrl || typeof dataUrl !== 'string') {
        return {
          ok: false,
          error: 'Screenshot capture failed',
          summary: "I couldn't capture the screen — the browser may have blocked screen capture. Try again and allow it.",
        };
      }
      const description = await ctx.describeImage(dataUrl, prompt).catch((err) => ({ __error: err?.message || String(err) }));
      if (description?.__error) {
        return { ok: false, error: description.__error, summary: `I captured the screen but the vision model failed: ${description.__error}` };
      }
      const text = typeof description === 'string' ? description.trim() : '';
      if (!text) {
        return { ok: false, summary: 'I captured the screen but the vision model returned nothing.' };
      }
      return {
        ok: true,
        content: text,
        path: ctx.state?.ui?.path || null,
        // Keep summary short — the full description is in `content` for the LLM
        // to speak verbatim (mirrors ui_read / ui_ask).
        summary: `Described the current screen (${text.length} chars).`,
      };
    },
  },
];
