# Metrics — PortOS

PortOS uses a small set of product-success signals in addition to infrastructure
and agent-run health. The purpose of these metrics is to identify where the app
should make the next user action easier or more visible.

| Product outcome | Goal | Signal | Healthy direction |
| --- | --- | --- | --- |
| Daily POST engagement | Cognitive training is a daily exercise | Whether scored POST or training activity occurred today; active days in the last 7 and 30 days; unified streak | Activity today and at least 5 active days in 7 |
| Creative feedback loop | Nightly commissions improve through user taste | Completed renders, unrated completed renders, oldest unrated age, and feedback coverage | Every completed render reviewed, preferably within 24 hours |
| Action discoverability | The app turns a detected gap into a visible next step | Daily-action projection and reminder delivery are available without an AI call | The user can open the exact POST launcher or commission run from the action |

## Source of truth

The live values are derived by the read-only
`server/services/portosProductMetrics.js` service from the local POST,
creative-commission, and Creative Director stores. The metrics preserve an
explicit `unavailable` status when a source cannot be read.

Layered Intelligence gathers the same aggregate values as its PortOS-only
`productMetrics` source. It receives counts and ages, not commission names,
briefs, prompts, or other record contents, and the source never invokes an AI
provider.
