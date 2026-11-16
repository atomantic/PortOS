/**
 * Tool-call / reasoning parser flags every local runtime MUST carry to serve a
 * Qwen3-family model to a CoS coding agent.
 *
 * ## Why this is a table and not prose
 *
 * The spelling is runtime-specific and the failure is SILENT. The server starts,
 * the model answers, the agent looks alive — and tool markup comes back as
 * ordinary assistant text with `tool_calls: null`, so the agent never reads or
 * writes a file. There is no error anywhere that names the parser.
 *
 * Measured, not guessed:
 *   - vLLM on the 3090 preset needs `--tool-call-parser qwen3_xml`
 *     (`docs/research/2026-08-21-qwen38-rtx3090-vllm.md`). `hermes` LOOKS right
 *     because the chat template emits `<tool_call>` markers, but Qwen3.8 writes
 *     its calls as XML (`<function=name><parameter=path>…`), not the Hermes JSON
 *     body — vLLM accepts the flag and then cannot parse a single call.
 *   - SGLang's verified cookbook cells all ship `--tool-call-parser qwen3_coder`
 *     AND `--reasoning-parser qwen3` (`docs/research/2026-08-21-sglang-qwen38-27b.md`).
 *     Without the reasoning parser the thinking block leaks into the reply.
 *
 * Two runtimes, two different spellings for the same model family. Left in prose,
 * the third runtime copies whichever doc ranks first. So: one table PortOS owns,
 * and every launch path reads it instead of typing a string.
 *
 * ## Do NOT auto-detect the parser from the chat template
 *
 * That is exactly how `hermes` got chosen. The template's markers describe how
 * the model is PROMPTED, not how it ANSWERS. The mapping below is empirical —
 * extend it only from a runtime's own verified launch line.
 *
 * ## Adding a runtime
 *
 * Add a row here (and a `parserFlagsFor` case is not needed — the builder is
 * generic). A row with both parsers `null` is a POSITIVE assertion that the
 * runtime has no equivalent flag today, not a placeholder: that is why `llama`
 * is listed. An unknown runtime throws rather than serving parser-less, because
 * a parser-less agent server is indistinguishable from a working one until a
 * whole session has been wasted.
 */

/**
 * runtime → flags that MUST be on the serve line for Qwen3-family coding agents.
 *
 * `enableAutoToolChoice` is vLLM-only and not cosmetic: vLLM rejects every
 * request that offers tools with `"auto" tool choice requires
 * --enable-auto-tool-choice and --tool-call-parser to be set`, so the parser
 * flag alone still kills the session on the agent's first turn. SGLang enables
 * tool choice implicitly once a parser is named and has no such flag.
 */
export const QWEN_AGENT_PARSERS = {
  vllm: { toolCallParser: 'qwen3_xml', reasoningParser: null, enableAutoToolChoice: true },
  sglang: { toolCallParser: 'qwen3_coder', reasoningParser: 'qwen3', enableAutoToolChoice: false },
  // llama-server has no tool-call/reasoning parser flags today — the null row is
  // the decision, so a future author does not go looking for one.
  llama: { toolCallParser: null, reasoningParser: null, enableAutoToolChoice: false },
};

/** Runtime keys this table knows about, in table order. */
export const QWEN_AGENT_RUNTIMES = Object.keys(QWEN_AGENT_PARSERS);

/**
 * The parser row for a runtime, or throw naming the runtimes that exist.
 *
 * Fail-fast is the point: a caller that fell through to "no flags" would launch
 * a server that answers fluently and never calls a tool.
 */
export function qwenAgentParsersFor(runtime) {
  // `hasOwn`, not truthiness: `QWEN_AGENT_PARSERS['toString']` is a live
  // prototype method, and a plain lookup would hand a caller an all-undefined
  // "row" that renders as zero flags — the exact silent-serve this throws for.
  const row = Object.hasOwn(QWEN_AGENT_PARSERS, runtime) ? QWEN_AGENT_PARSERS[runtime] : null;
  if (!row) {
    throw new Error(
      `Unknown Qwen agent runtime '${runtime}' — known runtimes: ${QWEN_AGENT_RUNTIMES.join(', ')}. ` +
        'Add a row to QWEN_AGENT_PARSERS (server/lib/qwenAgentParsers.js) from that runtime\'s verified launch line; do not serve without a tool-call parser.',
    );
  }
  return row;
}

/**
 * The argv fragment a runtime's serve line needs, e.g.
 * `['--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'qwen3']`.
 *
 * Always an array — including for vLLM, whose `.env` transport is a string.
 * A helper that returned an array for one runtime and a string for another
 * would push every caller into a typeof check; `vllmExtraArgs()` below joins
 * the same fragment for the one transport that needs the string form.
 * A runtime with no parser flags (llama) returns `[]`; an unknown one throws.
 */
export function parserFlagsFor(runtime) {
  const { toolCallParser, reasoningParser, enableAutoToolChoice } = qwenAgentParsersFor(runtime);
  return [
    ...(enableAutoToolChoice ? ['--enable-auto-tool-choice'] : []),
    ...(toolCallParser ? ['--tool-call-parser', toolCallParser] : []),
    ...(reasoningParser ? ['--reasoning-parser', reasoningParser] : []),
  ];
}

/**
 * The vLLM `EXTRA_ARGS` value — the string form of `parserFlagsFor('vllm')`,
 * appended to `vllm serve` by the syv-ai compose project's start script.
 *
 * This is what the guided install (#4767) writes into `.env`, and what
 * `docs/features/qwen38-rtx3090.md` documents; `qwenAgentParsers.test.js`
 * asserts the doc still quotes exactly this, so the snippet cannot drift away
 * from the table.
 */
export function vllmExtraArgs() {
  return parserFlagsFor('vllm').join(' ');
}
