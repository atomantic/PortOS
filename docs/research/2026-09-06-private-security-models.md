# Local models for private security assessments

Reviewed 2026-09-06. Follow-up research below prioritizes VulnLLM-R for a vulnerability-detection comparison and Cisco Foundation-Sec for security reasoning; neither should be assumed uncensored. Uncensored-category recommendation: **OrcaRouter Qwen3.8 27B Uncensored**, as a practical experimental candidate, not a proven security benchmark winner. The catalog puts it in **Security · Uncensored / abliterated**, separate from general coding recommendations. Refusal removal is not evidence of better vulnerability discovery or remediation.

## Benchmark evidence

| Candidate | CyberGym | ExploitGym | ExploitBench | Local suitability |
| --- | --- | --- | --- | --- |
| OrcaRouter Qwen3.8 27B Uncensored, MLX/GGUF | No exact-build result verified | No exact-build result verified | No exact-build result verified | Practical 27B candidate; quantization and context must be validated locally |
| Official Qwen3.8 27B | None found in its model card | None found in its model card | None found in its model card | Useful aligned baseline; its coding scores cannot be transferred to the abliterated derivative |
| GLM-5.3 | 84.5% | 105 / 130 successes, 2h / 6h budgets | 54.4 coverage score | Roughly 753B parameters; even theoretical 4-bit weights need about 377 GB before overhead |

GLM figures are **publisher-reported**, not independent measurements here. CyberGym uses pass@1 over 1,507 tasks, with unlimited task timeout. ExploitGym uses 869 tasks and normalized inference-time budgets. ExploitBench averages capability coverage on 41 tasks across three revisions; **54.4 is not an arbitrary-code-execution success percentage**. Source: [GLM-5.3 model card and evaluation footnotes](https://huggingface.co/zai-org/GLM-5.3), [parameter metadata](https://huggingface.co/api/models/zai-org/GLM-5.3).

[CyberGym](https://arxiv.org/abs/2506.02548) primarily measures reproduction of known vulnerabilities; the original paper's best framework/model configuration reached 11.9%. That older number is not comparable to a current leaderboard configuration without controlling the harness, task set, compute and budget. [ExploitGym](https://arxiv.org/abs/2605.11086) measures progression from a triggering input to exploitation across userspace, V8 and kernel targets; its paper describes an earlier 898-instance snapshot. The [current observatory](https://www.cybergym.io/) lists 869. [ExploitBench](https://exploitbench.ai/) grades 16 capabilities across five tiers, from coverage through arbitrary code execution. None directly establishes patch correctness or safe remediation on a managed app.

The [official Qwen card](https://huggingface.co/Qwen/Qwen3.8-27B) describes a dense 27B model with a native 262,144-token window. We found no supported basis to label its uncensored derivative the best security LLM. Missing results stay **unknown**, not zero and not inherited from another Qwen variant.

## Fit and provenance

For a 128 GiB Apple Silicon system, 4-, 6- and 8-bit weights leave substantial headroom. Actual usable RAM, concurrent models, KV cache and context settings still control fit. Prefer Q6_K/Q8_0 GGUF when quality matters and the live fit picker permits it. The MLX root is 4-bit; higher precisions are separate subfolders, not automatically selected by PortOS. The [publisher card](https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX) warns that 2-bit quality is degraded. Do not extrapolate its H200 throughput to a Mac.

Dated [MLX repository metadata](https://huggingface.co/api/models/orcarouter/Qwen3.8-27B-Uncensored-MLX?blobs=true) showed 1,308 likes and 141,300 monthly downloads; [GGUF metadata](https://huggingface.co/api/models/orcarouter/Qwen3.8-27B-Uncensored-GGUF?blobs=true) showed 748 and 287,720. [OrcaRouter's profile](https://huggingface.co/orcarouter) showed approximately 1,860 followers. Exact reviewed revisions are in `server/lib/localModelSafety.js`. Root MLX shards total approximately 16.05 GB; alternate quantizations and MTP weights must not be summed into the root's resident-size estimate.

These are reach/provenance signals, **not Hugging Face safety ratings**. No model bytes were downloaded or certified malware-free. Safetensors/GGUF reduce pickle/code-loading risk but do not eliminate parser vulnerabilities, poisoned behavior or compromised publishers. Use maintained runtimes without remote model code. The UI links the reviewed revision and states that existing backend installers resolve the current publisher release, not an immutable revision. Unknown publishers may remain discoverable, but are not curated recommendations. Existing installed mappings are retained.

## Private scheduled task

In CoS Scheduled Tasks, choose **Private security assessment**, select a managed app, and explicitly save a local CLI provider/model pin. Run on demand or configure the existing scheduler's cadence. Nothing runs at boot or downloads model weights automatically.

The task uses macOS Seatbelt around the tool-free CLI: separate scratch directory and home, read access to trusted runtime/system files, writes only to scratch, and TCP only to the chosen loopback inference port. Unsupported platforms, remote providers, cloud-proxy models and unavailable sandbox/runtime prerequisites fail closed. The inference daemon itself is a trusted, separately managed host process; this does not sandbox the weight parser inside that daemon.

PortOS reads immutable committed Git blobs without checking out or executing repository code. A bounded static snapshot prioritizes security-sensitive paths and records omitted coverage. The model cannot install packages, run tests/exploits, browse, edit source or publish. Reports require valid source locations, confidence, evidence, remediation and verification guidance. Empty findings do not constitute a security clearance. Findings are returned to the local Review Hub, with no issues, PRs, memory extraction or automatic failure-investigation task. Tasks and all completed source/transcript archive files are excluded from federation, including direct peer archive downloads. Shared report notifications carry only an ID. Review and remediation remain human decisions. A host interruption before validation requires a new assessment because its source inventory stays in run memory.

Before promoting a candidate beyond experimental status, measure the exact quantization and harness on authorized fixtures with known vulnerabilities and benign controls, check false positives and patch correctness, then record coverage and runtime. This change does not claim to have run CyberGym, ExploitGym or ExploitBench locally.


## Follow-up: specialist models from the linked article

Reviewed the [July 7 article shared by the user](https://x.com/0x0SojalSec/status/2074622871771717837) against original releases on 2026-09-06. X blocked direct retrieval; its article body was available through [the FxTwitter mirror API](https://api.fxtwitter.com/0x0sojalsec/status/2074622871771717837). The post is a discovery list, not a controlled comparison.

| Candidate | Verified evidence and limits | Assessment |
| --- | --- | --- |
| VulnLLM-R-7B | The [paper](https://arxiv.org/html/2512.07533v1) evaluates vulnerability detection in C/C++, Python and Java, and reports 15 previously unknown vulnerabilities using its agent scaffold. These are author-reported results for that setup, not evidence for our bounded tool-free prompt or JavaScript/TypeScript/Swift. | First specialist to compare for source vulnerability detection. No verified result on CyberGym, ExploitBench or ExploitGym found in the reviewed sources. |
| Foundation-Sec-8B-Reasoning | [Cisco's model card](https://huggingface.co/fdtn-ai/Foundation-Sec-8B-Reasoning) reports CTI-MCQA 0.691, CTI-RCM 0.753 and CTI-Reasoning 0.411 with zero-shot prompting at temperature 0.3. It is safety-aligned, with a 32,768-token training sequence length. | Strong provenance and a useful security-reasoning baseline; CTI scores do not establish source vulnerability discovery or patch correctness. |
| CyberSecQwen-4B | Its [publisher](https://huggingface.co/athena129/CyberSecQwen-4B) reports CTI-MCQ 0.5868 and CTI-RCM 0.6664, means over five trials. A defensive SFT/hackathon project with no safety RLHF; that does not establish deliberate abliteration. | Lower priority for this task. Threat-intelligence classification evidence is not source-audit evidence; publisher reach is limited. |
| Meta-SecAlign-8B | The [official Meta release](https://huggingface.co/facebook/Meta-SecAlign-8B) is a gated LoRA adapter, not a complete standalone 8B checkpoint. Its defense requires the prescribed template and separate untrusted `input` role. | Relevant to future prompt-injection defenses, but neither an uncensored model nor a proven vulnerability specialist. Our current flattened CLI prompt cannot be assumed to preserve that defense. |

### Publisher and artifact review

The [VulnLLM-R project repository](https://github.com/ucsb-mlsec/VulnLLM-R) links `UCSB-SURFI/VulnLLM-R-7B`, which currently redirects to [Virtue-AI-HUB/VulnLLM-R-7B](https://huggingface.co/Virtue-AI-HUB/VulnLLM-R-7B). Follow this original-project chain instead of selecting an identically named search-result reupload. Research lineage can be meaningful even when follower counts are modest.

Hugging Face API snapshots on the review date:

| Original release | Likes / monthly downloads | Revision | Weight bytes, decimal GB |
| --- | --- | --- | --- |
| Virtue-AI-HUB/VulnLLM-R-7B | 240 / 4,430 | `8cd13d7a35f13b187102dba166413d4450836a40` | 15.231 BF16 |
| fdtn-ai/Foundation-Sec-8B-Reasoning | 73 / 23,366 | `63c930c82d7646226d33502bec5870019738400e` | 16.061 BF16 |
| athena129/CyberSecQwen-4B | 10 / 441 | `6c82bf137b2c7446b4c17ba83f8090544702b077` | 8.045 BF16 |
| facebook/Meta-SecAlign-8B | 14 / 743 | `fb9b039b45ab4fe5e94517efaaf19f80f4fedda1` | 0.281 adapter only; base weights also required |

Counts measure reach, not safety or capability. The originals' roughly 8–16 GB weight sizes are practical on a 128 GiB system; runtime and context consume additional memory. Aggressive 2-bit quantization is unnecessary for these candidates.

Concrete conversion candidates for local evaluation:

- [mlx-community/VulnLLM-R-7B-8bit](https://huggingface.co/mlx-community/VulnLLM-R-7B-8bit): 8.092 GB root safetensors; revision `a11ea278f27c95061a4a4d3a2ac53d4164a37bd9`. Its base metadata points to the original UCSB release.
- [mradermacher/VulnLLM-R-7B-GGUF](https://huggingface.co/mradermacher/VulnLLM-R-7B-GGUF): Q8_0 8.099 GB; revision `6ce5015efa4210be17c1c3034ba5dd5ca36d0d63`; card links the original model.
- [Cisco's own Foundation-Sec Q8_0 GGUF](https://huggingface.co/fdtn-ai/Foundation-Sec-8B-Reasoning-Q8_0-GGUF): 8.541 GB; revision `010378322d06cccff4cb64ad62997411f2bd511f`. Prefer the original publisher's conversion over an unknown reupload.

### Decision

Keep security specialization and reduced safeguards as separate catalog attributes. VulnLLM-R and Foundation-Sec are curated in the **Security specialists** category; retain Qwen Uncensored in its explicit reduced-safeguard category. Do not blanket-approve new publishers or label these four models abliterated from this post.

The next evaluation should compare VulnLLM-R, Foundation-Sec and the existing Qwen candidate on the same bounded source snapshots, including vulnerable/benign pairs and realistic JavaScript/TypeScript/Swift cases. Measure false positives, evidence locations, valid report JSON, remediation correctness and runtime. Reserve context for the answer, particularly for Foundation-Sec. Keep the existing local-only sandbox/report restrictions. Strix or the paper's autonomous scaffold would introduce a different execution policy and cannot be silently substituted.

The catalog includes the verified Q8_0 GGUF conversions of VulnLLM-R and Foundation-Sec for both supported local runtimes. No weights were downloaded, external model code executed, or assessments started. Selection is based on original releases and conversion provenance; no local comparative benchmark has been run.
