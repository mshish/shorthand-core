# Setup/config app — brief for a new brainstorming session

**Status: brief, not a design. Decisions and constraints carried forward from prior research;
everything else (UI/UX flow, IPC shape, updater design, exact OAuth screens) is intentionally
undecided and should go through its own clarifying-questions + design pass, not be inferred from
this document.**

**Not committed to git — written to disk only, at the user's request, until reviewed.**

## What this app is for

A separate, proprietary, cross-platform desktop app (Windows + macOS required, Linux nice-to-have)
that is the paid product's actual value surface. It is explicitly **not** a DIY-prevention
mechanism — the user is fine with a technical organization duplicating the entire stack from the
open-source repos ("that's not deal-breaking"). The value it sells is hand-holding for a
non-technical individual who already pays for Claude or ChatGPT but has never touched a CLI:

- Detect/install the `claude` CLI and guide (or automate where possible) `claude login`, using the
  user's own existing Anthropic subscription.
- Install and update `shorthand` (the Tauri fork) and `shorthand-core`.
- Let the user pick which integrations/outputs they want (Obsidian plugin, Google Docs) and
  install/configure each.
- **Ongoing configuration**, not just first-run setup — this was specifically called out because
  Obsidian already has its own in-app settings UI, but Google Drive/Docs does not, so this app is
  where a user changes their target document or Google account later.

Everything this app touches or produces should remain fully reproducible by hand from the open
repos — the transparency is deliberate and, per the user, expected to be a *selling* point rather
than a risk to guard against.

## Decisions already made (carry forward, don't re-derive)

- **Separate app, separate repo** — not folded into the existing Shorthand Tauri app. It's a
  second, deliberately monetized product, not an incidental convenience layer on the free one.
- **Technology: Tauri** (same stack as the existing fork) is the standing recommendation —
  team already knows Rust + TypeScript, small bundle size, has a built-in updater, loopback OAuth
  is straightforward from Rust. This was a recommendation from prior research, not yet stress-
  tested against this app's specific requirements (e.g. whether it needs to supervise/restart a
  background process the way the existing fork does) — worth confirming rather than assuming.
- **The OAuth/Picker consent flow for Google lives here — but a working reference already
  exists.** Core now ships `shorthand-notes google-login`, a CLI bootstrap that performs the same
  browser-based OAuth + Picker consent round-trip (`trigger_onepick=true`) and a file-backed
  `TokenProvider` implementation to go with it — see the sibling spec,
  `2026-08-18-google-docs-sink.md`. This app's job is not to invent that flow, only to give it a
  GUI and swap the storage from a local file to the OS keychain: a second `TokenProvider`
  implementation against the same interface, same "one port, multiple implementations" pattern as
  everything else in this codebase. This app does **not** proxy or broker Google API calls at
  runtime — only the consent UX and credential storage are its job.
- **No brokered Claude inference.** The installer's job regarding Claude is to get the user logged
  into their own `claude` CLI via Anthropic's own official login flow — not to implement its own
  OAuth broker, and not to route traffic through app-held credentials. See the ToS risk note below;
  this choice is precisely what that risk is about.
- **Licensing/entitlement vendor is undecided** (Polar was researched and is a candidate; the user
  does not want it locked in yet, and mentioned wanting to check whether Stripe has an offline
  license option — unverified, and the research so far points to Keygen, not Stripe, as the
  offline-signed-license specialist). This app's design should not assume a specific vendor's SDK
  shape; treat "check license validity" as a small internal interface this app calls, backed by
  whichever vendor is chosen later.
- **Code signing cost, if useful context for scoping:** prior research put this around $99/year
  (Apple Developer Program) + roughly $120/year (Azure Trusted Signing, the current recommended
  path for Windows OV/EV signing without a physical HSM) — check `SIGNING_AND_UPDATES.md` in the
  Handy fork before treating this as new work, since some of the CI/signing pipeline may already
  exist there and be reusable or adaptable.

## Open risk to carry forward: Anthropic's Claude Code terms of service

Anthropic's compliance page states products/services using the Agent SDK should use API key
authentication, and that third-party developers may not route requests through Free/Pro/Max
subscription credentials on behalf of users. This app's core value proposition — guiding a
non-technical user into logging their own `claude` CLI into their own subscription, for use by a
paid product — sits close to the language that page uses, even though what's being automated is
the user's own official login flow rather than an app-built OAuth broker. This is flagged in more
detail in the prior research; the working plan is to proceed, describe the feature honestly (not
as "unlimited AI"), ship a BYO-API-key path as a real alternative rather than a someday item, and
contact Anthropic directly about the specific use case before revenue depends on the answer. If
that conversation goes badly, the documented exit ramp is the already-planned move to a
lighter-weight, non-Agent-SDK workflow (LangGraph/LangChain/Strands-shaped) with brokered or BYO
model access — which is on the roadmap anyway, just not built yet.

## Known future direction that should inform (not block) this app's design

The agent backend is expected to become pluggable over time: Claude Agent SDK first, then a Codex
Agent SDK backend, then ACP, then raw API — "probably all before releasing." This app's
integration-picker UI and its Claude-login-guidance step should be built with the expectation that
"which AI backend" becomes a user choice, not a permanent assumption — though the actual
`AgentClient` port work that enables this is separate, already-scoped-out work in core
(`src/agent/contract.ts`) and not part of this app's build.

## What needs a real design pass in the new session (deliberately not decided here)

- Overall app structure: onboarding wizard vs. persistent settings app vs. both; how it relates to
  (or supervises) the already-running Shorthand Tauri app and `shorthand-core` process.
- The Claude CLI detection/login UX specifically — what can actually be automated vs. what must be
  "open a terminal and run this command, then click continue," given `claude login`'s own flow is
  not itself scriptable from outside.
- The Google Docs/Drive configuration screen — since this is the one integration with no native
  settings surface of its own, this app owns its entire UX: connect account, pick a Picker target,
  change target later, disconnect/revoke.
- The Obsidian integration screen — likely much thinner, since Obsidian has its own settings UI;
  probably just "install/update the plugin" plus a deep link or instructions.
- Update mechanism and channel (Tauri's built-in updater is the likely default, per prior
  research, but signing-key custody and release process need designing).
- How licensing/trial state surfaces in the UI, once a vendor is chosen.
- Linux scope: how far "nice to have" goes — packaging format, whether the guided-install flow is
  even attempted there or Linux gets documentation-only support.
- Telemetry/error-reporting posture, if any — worth deciding explicitly given the transparency
  positioning of the rest of the product.

## Related documents

- `2026-08-18-google-docs-sink.md` — the `TokenProvider` contract this app must satisfy, and the
  `GoogleDocsNoteSink` design it feeds credentials to.
- Prior research (not committed anywhere permanent yet — currently only in
  `C:\Users\<user>\.claude\plans\architecture-question-should-shorthand-c-rustling-sutton.md` on
  the machine that ran it) covers: the open/closed licensing boundary and why the "everything
  except the installer" line was chosen, per-component license recommendations, the billing/MoR
  landscape, and the full Google Docs API research this spec's sibling draws from. Worth
  extracting the durable parts of that into a real committed doc before it's lost to that
  conversation's context.
