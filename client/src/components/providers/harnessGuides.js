/**
 * Static "why pick this harness" notes for the Harnesses tab info icon: one best-for line plus strengths and limits per registry harness id.
 *
 * The local-runtime claims mirror the server's binding table (`server/lib/provider/providerHarnesses.js`)
 * and the service transports in `server/lib/serviceDefinitions.js`: Claude Code needs an Anthropic-wire
 * service (Ollama, SGLang), Codex's local mode covers Ollama and LM Studio, Pi reaches only the providers
 * it ships, and OpenCode and Hermes take any OpenAI-compatible endpoint. Update both when a binding changes.
 */

export const HARNESS_GUIDES = Object.freeze({
  claude: {
    bestFor: 'Long multi-step coding runs on Claude models, or on a strong local model behind an Anthropic-compatible server.',
    strengths: [
      'Most mature tool loop: subagents, MCP, hooks and skills.',
      'PortOS passes the effort level on every run.',
      'Locally it works through Ollama or SGLang, which speak the Anthropic API.',
    ],
    limits: [
      'Large system prompt plus tool definitions: give a local model 64K or more of context.',
      'Cannot use MTPLX, LM Studio or llama.cpp here (OpenAI API only).',
      'Local servers skip prompt caching and give approximate token counts.',
    ],
  },
  opencode: {
    bestFor: 'The default for local models: works with every runtime, including MTPLX and llama.cpp.',
    strengths: [
      'Takes any OpenAI-compatible endpoint, so every local runtime and gateway fits.',
      'Free Zen models need no key.',
      'Effort reaches the model through its agent config.',
    ],
    limits: [
      'Tool calls are only as good as the server\'s chat template (llama.cpp needs --jinja).',
      'Plan on 32K or more of context for agent work.',
    ],
  },
  codex: {
    bestFor: 'GPT models on a ChatGPT plan, with Ollama or LM Studio as a local fallback.',
    strengths: [
      'Strong planning and code review on its own models.',
      'Effort levels pass through.',
      'Local mode (--oss) runs on Ollama or LM Studio.',
    ],
    limits: [
      'Tuned for OpenAI models; small local models often stumble on its tool format.',
      'No MTPLX or llama.cpp binding.',
    ],
  },
  pi: {
    bestFor: 'Lean cloud runs where a short prompt and low overhead matter more than features.',
    strengths: [
      'Very short system prompt and only four tools (read, write, edit, bash).',
      'Supports thinking levels on models that have them.',
      'Reaches many cloud services it ships names for (Anthropic, OpenAI, Google, OpenRouter, NVIDIA and others).',
    ],
    limits: [
      'No local runtime here: a custom endpoint lives in Pi\'s own models.json, which PortOS does not write.',
      'No MCP, subagents or plan mode.',
    ],
  },
  hermes: {
    bestFor: 'General assistant work with memory and skills on any OpenAI-compatible model.',
    strengths: [
      'Works with every local runtime and gateway through one OpenAI-compatible endpoint.',
      'Ships many built-in skills and keeps memory between sessions.',
      'Reads large prompts from stdin, so prompt size is not limited by the command line.',
    ],
    limits: [
      'No per-run effort setting, so PortOS cannot pass effort.',
      'Every run has tools on, so it cannot serve tool-free requests.',
      'Built as a general agent, not tuned for coding.',
    ],
  },
  kilo: {
    bestFor: 'People who already use Kilo Code and its own provider setup.',
    strengths: ['A fork of OpenCode with the same terminal workflow.'],
    limits: ['Reads its backend from its own config, so PortOS cannot point it at a service.'],
  },
  openchamber: {
    bestFor: 'Driving a workspace you already run in OpenChamber\'s web UI.',
    strengths: ['A web control plane over an agent runtime you sign in to yourself.'],
    limits: ['Headless only, with no terminal UI.', 'Its models are set in its own UI, not from PortOS services.'],
  },
  antigravity: {
    bestFor: 'Gemini models on a Google Antigravity plan.',
    strengths: ['Uses plan quota instead of per-token billing.'],
    limits: ['Reaches only its own vendor service, never local models.'],
  },
  cursor: {
    bestFor: 'Models on a Cursor plan.',
    strengths: ['Uses plan quota; many frontier models behind one sign-in.'],
    limits: ['Reaches only its own vendor service, never local models.', 'No effort flag; the level is folded into the model name.'],
  },
  grok: {
    bestFor: 'Grok models on an xAI plan.',
    strengths: ['Uses plan quota; effort levels pass through.'],
    limits: ['Reaches only its own vendor service, never local models.'],
  },
  kimi: {
    bestFor: 'Kimi models on a Moonshot plan.',
    strengths: ['Uses plan quota on a strong agentic open-weight family.'],
    limits: ['Reaches only its own vendor service, never local models.'],
  },
  direct: {
    bestFor: 'Single-shot generation and chat where no agent loop is needed.',
    strengths: [
      'PortOS\'s own HTTP client: no extra prompt, the lowest overhead and fastest first token.',
      'Works with any OpenAI-compatible service, local or hosted.',
    ],
    limits: ['No tools or file access, so it cannot run agent tasks.'],
  },
});
