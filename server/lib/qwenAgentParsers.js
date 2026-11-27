/**
 * Tool-call / reasoning parser flags every local runtime MUST carry to serve a Qwen3-family model to a CoS coding agent.
 *
 * A table, not prose: the spelling is runtime-specific and the failure SILENT (the server starts and the model answers, but tool markup returns as assistant text with `tool_calls: null`, so the agent never reads or writes a file, with no error naming the parser).
 * Measured: vLLM on the 3090 preset needs `--tool-call-parser qwen3_xml` (`hermes` LOOKS right since the template emits `<tool_call>` markers, but Qwen3.8 writes XML `<function=name><parameter=path>…`, not Hermes JSON, and vLLM accepts the flag then parses nothing);
 * SGLang's verified cells ship `--tool-call-parser qwen3_coder` AND `--reasoning-parser qwen3` (without the latter the thinking block leaks into the reply). One table PortOS owns; every launch path reads it.
 * Do NOT auto-detect the parser from the chat template (how `hermes` got chosen): its markers describe how the model is PROMPTED, not how it ANSWERS; extend only from a runtime's own verified launch line.
 * Adding a runtime: add a row (the builder is generic). A row with both parsers `null` POSITIVELY asserts no equivalent flag exists (why `llama` is listed); an unknown runtime throws rather than serving parser-less, which is indistinguishable from working until a session is wasted.
 */

/** runtime → flags that MUST be on the serve line for Qwen3-family coding agents. `enableAutoToolChoice` is vLLM-only and not cosmetic: vLLM rejects every request offering tools (`"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser`) so the parser flag alone still kills the first turn; SGLang enables tool choice once a parser is named. */
export const QWEN_AGENT_PARSERS = {
  vllm: { toolCallParser: 'qwen3_xml', reasoningParser: null, enableAutoToolChoice: true },
  sglang: { toolCallParser: 'qwen3_coder', reasoningParser: 'qwen3', enableAutoToolChoice: false },
  // llama-server has no tool-call/reasoning parser flags; the null row is the decision, so nobody goes looking for one.
  llama: { toolCallParser: null, reasoningParser: null, enableAutoToolChoice: false },
};

/** Runtime keys this table knows about, in table order. */
export const QWEN_AGENT_RUNTIMES = Object.keys(QWEN_AGENT_PARSERS);

/** The parser row for a runtime, or throw naming the runtimes that exist; fail-fast since falling through to "no flags" would launch a server that answers fluently and never calls a tool. */
export function qwenAgentParsersFor(runtime) {
  // `hasOwn`, not truthiness: `QWEN_AGENT_PARSERS['toString']` is a live prototype method and a plain lookup would hand back an all-undefined "row" rendering as zero flags (the silent serve this throws for).
  const row = Object.hasOwn(QWEN_AGENT_PARSERS, runtime) ? QWEN_AGENT_PARSERS[runtime] : null;
  if (!row) {
    throw new Error(
      `Unknown Qwen agent runtime '${runtime}' — known runtimes: ${QWEN_AGENT_RUNTIMES.join(', ')}. ` +
        'Add a row to QWEN_AGENT_PARSERS (server/lib/qwenAgentParsers.js) from that runtime\'s verified launch line; do not serve without a tool-call parser.',
    );
  }
  return row;
}

/** The argv fragment a runtime's serve line needs, e.g. `['--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'qwen3']`. Always an array (even for vLLM, whose `.env` transport is a string: mixed return types force typeof checks; `vllmExtraArgs()` joins it); `[]` for llama, throws for an unknown runtime. */
export function parserFlagsFor(runtime) {
  const { toolCallParser, reasoningParser, enableAutoToolChoice } = qwenAgentParsersFor(runtime);
  return [
    ...(enableAutoToolChoice ? ['--enable-auto-tool-choice'] : []),
    ...(toolCallParser ? ['--tool-call-parser', toolCallParser] : []),
    ...(reasoningParser ? ['--reasoning-parser', reasoningParser] : []),
  ];
}

/** The vLLM `EXTRA_ARGS` value: the string form of `parserFlagsFor('vllm')`, appended to `vllm serve` by the syv-ai compose start script. Written into `.env` by the guided install (#4767) and documented in `docs/features/local-llm-runtimes.md#vllm-on-rtx-3090` (`qwenAgentParsers.test.js` asserts the doc quotes exactly this). */
export function vllmExtraArgs() {
  return parserFlagsFor('vllm').join(' ');
}
