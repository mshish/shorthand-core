# `shorthand-config` v1 — design spec

**Status: design spec, approved in chat, ready for the implementation plan.** This is the first
document that turns the settled brief (`2026-08-19-shorthand-config-app-brief.md`) and its handoff
(`2026-08-19-shorthand-config-handoff.md`) into concrete build decisions. It answers the brief's
"Open questions" list. **This copy lives in `shorthand-core` only because `shorthand-config` does
not exist yet.** Once the repo is scaffolded, this file moves there.

Read in this order before this document: the handoff, the app brief, and
`2026-08-19-google-oauth-boundary-design.md` (core's side of the boundary). This document does not
restate what those already settle — the one-way dependency, the six-step auth flow, the credentials
file contract, the scope guard's purpose. It restates only what's needed to state a decision.

**Scope, unchanged from the brief, not re-litigated here:** v1 is exactly three things — an
installable artifact (Windows, macOS, Linux), the auto-updater wired end to end, and the Google
consent flow producing the credentials file.

---

## 1. Repository and stack

`mshish/shorthand-config`, private, scaffolded via `bun create tauri-app`. Rust + TypeScript, pinned
to match the Handy fork for consistency across the two apps under maintenance:

- `tauri = "2.11.5"`
- `tauri-plugin-updater = "2.10.0"`
- `@tauri-apps/api ^2.11.0`

Frontend: React/TypeScript (matching Handy's stack, no new framework introduced for one settings-app
UI).

### Layout

```
shorthand-config/
├── src/                        # React frontend — connect button, status, target picker
├── src-tauri/
│   ├── src/
│   │   ├── google/
│   │   │   ├── oauth.rs        # ports src/google/oauth.ts
│   │   │   ├── container_doc.rs # ports src/google/container-doc.ts
│   │   │   └── credentials.rs  # the writer — new contract, not a port of writeCredentials
│   │   ├── scope_guard/        # test-only: the copied, adapted scope guard
│   │   └── main.rs
│   ├── binaries/                # bundled shorthand-core sidecars, one per target triple
│   ├── capabilities/
│   └── tauri.conf.json
└── .github/workflows/
    ├── build.yml
    └── release.yml
```

---

## 2. `shorthand-core`: bundled now, as a Tauri sidecar — wired, not deferred

**Decision, confirmed directly: build this now, fully wired.** This is the brief's own
recommendation ("Bundle for v1, behind a resolver") taken as settled, not re-opened.

**Mechanism: Tauri's `bundle.externalBin`, not a hand-rolled resolver.** The brief's TypeScript
resolver (`detectShorthandExecutable` in `shorthand-core/src/config.ts`) exists for *consumers of the
published core package* — the Obsidian plugin, a terminal user — who need to find a core binary that
might arrive via npm/bun install, a PATH entry, or a platform-conventional install location. That is
not `shorthand-config`'s problem: it bundles its own copy and Tauri already has a first-class
mechanism for exactly this shape — a sidecar binary shipped inside the app bundle, resolved by target
triple.

- `shorthand-core` is compiled via `bun build --compile` (per the brief's verified Windows result;
  see §5 for macOS) into a standalone executable, one per target triple
  (`shorthand-notes-x86_64-pc-windows-msvc.exe`, `shorthand-notes-aarch64-apple-darwin`,
  `shorthand-notes-x86_64-apple-darwin`, `shorthand-notes-x86_64-unknown-linux-gnu`), named and
  placed exactly as `bundle.externalBin` requires.
- `tauri.conf.json`'s `bundle.externalBin` lists it; `src-tauri/capabilities/` grants the `shell:
  allow-execute` (or sidecar-scoped equivalent) permission for it.
- Invoked, when there's a reason to, via `tauri_plugin_shell::process::Command::sidecar("shorthand-notes")`
  — Tauri resolves the platform-correct binary automatically; no path-search logic to write or test.

**"Wired" means provably spawnable, not feature-complete.** v1 has no capture-triggering UI — that
stays explicitly out of scope per the brief. What "wired" buys: a CI verification step that spawns
the bundled sidecar (`shorthand-notes --version` or equivalent) and asserts it runs, proving the
packaging pipeline actually produces a working embedded binary. The day the capture/enhance wiring
spec lands, `shorthand-config` already has a working, tested path to `shorthand-core` — it only needs
to add the UI and the actual invocation, not solve bundling from scratch.

**No process supervision in v1.** Nothing in v1 runs core as a long-lived background process — every
future call site is a one-shot subprocess (spawn, wait, read output). Supervision (restart-on-crash,
keep-alive) has no subject to apply to until a long-running capture exists, so it isn't designed here.

---

## 3. OAuth client id/secret embedding

**Decision: Rust `env!()`, reading build-time environment variables into `&'static str` constants.**

```rust
const GOOGLE_CLIENT_ID: &str = env!("SHORTHAND_CONFIG_GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET: &str = env!("SHORTHAND_CONFIG_GOOGLE_CLIENT_SECRET");
```

- **Names are distinct from core's** (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, stripped from core's env in
  `bin/shorthand-notes.ts`'s `withoutGoogleOAuthEnv`) — different purpose, different owner, and reusing
  the name would read as though they're the same concern when they are opposite ends of the one-way
  dependency.
- **This is standard Rust, not a Tauri-specific mechanism** — `env!` reads at `cargo build` time and
  fails the *compile* if the variable is unset. That is a feature: a release build silently missing
  the secret is not possible, versus a runtime check that could be skipped or a value that could
  silently be empty.
- No `build.rs`, no `tauri.conf.json` substitution — both considered, both are more machinery for the
  identical result.
- **Local development:** a gitignored `.env`-equivalent sourced into the shell before `bun run tauri
  dev` (standard `direnv` or a documented manual `export`, not Tauri/Vite's `.env` loading — that
  affects the frontend bundler, not `cargo build`'s environment).
- **CI:** GitHub Actions repository secrets, injected as `env:` on the release build step only — never
  on PR/test builds, which don't need real credentials and shouldn't have them available to leak.
- **Registering the actual Google Cloud OAuth client is a manual, human step** — creating the project,
  configuring the consent screen, generating the client id/secret. Not automatable from here.

---

## 4. Release pipeline

**Action version: `tauri-apps/tauri-action@v1`.** Handy's `@v0` pin (`build.yml:515`) is stale;
`v1` is current and is what this app starts on rather than inheriting the older pin.

**`tauri.conf.json` bundle config:**

```json
{
  "bundle": {
    "createUpdaterArtifacts": true,
    "targets": ["nsis", "app", "dmg", "deb", "appimage", "rpm"]
  }
}
```

Explicit targets, not `"all"` — `"all"` risks `tauri-action`'s Windows updater-artifact selection
defaulting to the `.msi` instead of the `.exe`/nsis installer in `latest.json`. Set
`updaterJsonPreferNsis: true` (or the current `tauri-action` input with equivalent effect) explicitly
rather than relying on a default.

**Update signing:** a **fresh** minisign keypair, generated for this app specifically — never reuse
the Handy fork's key. Private key and password supplied as real GitHub Actions secrets
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Confirmed: Tauri's signer does
not read `.env` files for these — they must be real environment variables at the point the updater
bundler runs, i.e. CI secrets or an explicit shell export locally. **Key custody matters from day
one**: back the private key up somewhere that survives losing the machine that generated it; there is
no recovery path if it's lost, only a forced reinstall for every existing user.

**Distribution split, per the brief's already-settled decision:** source stays in the private
`mshish/shorthand-config`; releases (artifacts + `latest.json`) publish to a separate **public**
repository, `mshish/shorthand-config-releases`. `plugins.updater.endpoints` points there. This must be
right before the first release ships — the endpoint is baked into every installed binary and cannot
be changed retroactively without stranding existing installs.

**CI structure:** two workflows, following Handy's own pattern but stripped of anything audio-stack
related (there is none here):

- `build.yml` — PR/branch verification: `cargo fmt --check`, `cargo clippy`, `cargo test`
  (including the scope guard and conformance fixture, §7–8), frontend lint/typecheck/build, and a
  debug build (`--no-bundle`) on all three OS runners, no signing, no secrets.
- `release.yml` — `workflow_dispatch`, following Handy's own draft-release-then-fill shape
  (`create-release` job creates a draft GitHub Release from `tauri.conf.json`'s version; a matrix job
  per platform builds, signs, and uploads to it via `tauri-action`).

**Build matrix**, following Handy's own precedent directly:

| Platform | Runner | Notes |
| --- | --- | --- |
| Windows | `windows-latest` | NSIS installer, unsigned (§5) |
| macOS (Apple Silicon) | `macos-latest` (or pinned to whichever image has arm64 native) | `.app` + `.dmg`, Developer ID signed + notarized |
| macOS (Intel) | `macos-13` or equivalent x86_64 runner | same signing |
| Linux (deb) | `ubuntu-22.04` | matches Handy's choice of the older LTS for `.deb` compatibility |
| Linux (AppImage + rpm) | `ubuntu-24.04` | matches Handy's split |

Each platform job also builds and embeds its target-triple `shorthand-core` sidecar (§2) before
invoking `tauri-action`.

---

## 5. `bun build --compile` on macOS

**Confirmed real, recent instability — not merely "untested."** Bun issues #29120 and #29270
document a regression in `bun build --compile --target=bun-darwin-arm64` (Bun ~1.3.12) that produces
a truncated code signature, causing macOS to kill the binary on launch (exit 137) — affecting both
native macOS builds and Linux→Darwin cross-compilation. Fixed by PR #29272.

**Decisions:**

1. **Build natively on a macOS CI runner, not cross-compiled.** The app needs a macOS runner for
   Developer ID signing and notarization regardless (§4's matrix), so cross-compiling `shorthand-core`
   from Linux to save runner time buys nothing — it only reintroduces a bug class native building
   sidesteps.
2. **Pin the Bun version used to compile `shorthand-core` to one at or after PR #29272.** Record the
   exact version in the workflow, not "latest."
3. **Treat the first CI run as the actual answer**, not something to assume works from the Windows
   result. This is why it's the first task in the implementation plan (§9 below), not something
   deferred to "later verification."

---

## 6. Code signing

**Windows: ship unsigned for v1.** SmartScreen shows a warning; "More info → Run anyway" works. This
matches Handy's own documented default for personal-scale use. New finding: Azure Artifact Signing
(the renamed Azure Trusted Signing) currently appears, per community reports not yet pinned to a dated
Microsoft statement, to restrict individual-developer onboarding to organizations with an established
billing history — so the paid route Handy's own doc describes may not be straightforwardly available
right now even if wanted later. Revisit if/when that's confirmed one way or the other; not blocking
for v1.

**macOS: Developer ID + notarization, required — cost already accepted in the brief.** New reinforcing
finding: as of macOS Sequoia 15.1, the classic Control-click Gatekeeper bypass for unsigned/unnotarized
apps was removed. An unsigned macOS build is no longer "shows a scary warning, user can proceed" — it
is much closer to "will not launch." This doesn't change the decision (already required), but it
firms up why: there's no longer a viable unsigned fallback for macOS distribution at all. Cost:
$99/yr Apple Developer Program.

CI reuses the Handy fork's keychain-import step verbatim (`build.yml` L220-242): `security
create-keychain` → `import` → `set-key-partition-list` → `find-identity`, gated on
`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `KEYCHAIN_PASSWORD` secrets specific to this
app's own Apple Developer account (never Handy's).

---

## 7. Connected-state detection

**Decision: read back the credentials file the app itself wrote.** Per the boundary spec, the
one-writer-per-file rule governs *writes*; a reader that only displays state does not violate it.
`shorthand-config` knows its own write path (it's the same `credentialsPath()` the conformance
fixture's "path" scenario already pins) and parses the file it wrote to render "connected to Google,
targeting document X" — or "not connected" if the file is absent or fails validation.

This does mean `shorthand-config` parses a format `shorthand-core` defines. That's exactly what the
published conformance fixture (§8) is for: the read side isn't independently deriving the schema, it's
reading back what the write side just wrote, in the same process, using the same Rust types.

---

## 8. Scope guard

Ported as a Rust test, **not a literal copy** of core's TypeScript version — copying literally would
walk only `src/` for `.ts` files, find zero matches (this app's consent code is Rust), and pass
vacuously, which is the exact weakness the boundary spec calls out.

- Walks `src-tauri/**/*.rs` **and** `src/**/*.{ts,tsx}` (a URL could theoretically be built in either
  place).
- Matches `googleapis\.com/auth/[\w.]+`, fails on anything that isn't `drive.file`.
- **Positive assertion**: at least one `drive.file` match must exist, anchored specifically on the
  Rust file that builds the authorization URL (`src-tauri/src/google/oauth.rs`), not on any file that
  merely mentions a scope.
- Verified by mutation as part of its own test: deleting the scope constant fails the positive half;
  adding a second scope in a `.rs` file under `src-tauri/` fails the negative half. This is the
  scenario that catches an accidentally-vacuous copy — it must specifically use a `.rs` file, since
  that's the language the frontend-only literal copy would have missed.

The `drive.file` scope string is duplicated from core's `GOOGLE_DOCS_SCOPE`, not imported — importing
it would mean this Rust app taking a build dependency on core's raw-TypeScript export map for one
string literal, the forbidden dependency direction in miniature. The duplication is safe specifically
*because* both repos' guards exist and both run in CI; an unnoticed divergence becomes a test failure
on whichever side drifts. This reasoning is recorded as a comment next to the duplicated constant, not
only here.

---

## 9. Credentials conformance fixture (CI-only)

Per the boundary spec: core publishes `describeGoogleCredentialsConformance` and
`GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS` from `shorthand-core/testing` (TypeScript). This app's CI
runs that suite against its own Rust writer via a thin harness.

- **Cross-repo checkout:** both `mshish/shorthand-config` and `mshish/shorthand-core` are private
  repos under the same personal account (not an org), so the default `GITHUB_TOKEN` scoped to
  `shorthand-config` cannot read `shorthand-core`. CI needs a **personal access token with `repo`
  scope**, stored as a secret (e.g. `CORE_REPO_PAT`), used only for this checkout step.
- **Pinned tag**, not a branch — matching `obsidian-shorthand`'s existing pattern
  (`"shorthand-core": "github:mshish/shorthand-core#<tag>"`) so this app's CI doesn't silently pick up
  unreleased core changes.
- **The harness is the language boundary**, per the boundary spec: the TypeScript scenarios never
  change; `write()` shells out to a test-only subcommand of this app's own compiled binary
  (`shorthand-config --test-write-credentials <json>` or equivalent), which performs the real Rust
  write and reports the path back.
- **This is a CI-only dependency.** Bun (or Node + a TS loader) is required to execute core's raw
  `.ts` export map during CI; it is never part of the shipped app, its runtime, or its installer.

---

## 10. Explicitly out of scope for this design (unchanged from the brief)

Installing the transcription app or Obsidian plugin, Claude CLI detection, agent-backend selection,
licensing/entitlement UI, telemetry, any capture-triggering UI, process supervision, OS keychain
storage (deferred per the boundary spec — the route is recorded there, not designed here), a
"bring your own OAuth client" escape hatch.

---

## Open items carried into the implementation plan, not resolved here

1. **First CI run on macOS is the real test of §5** — pin the Bun version, run it, confirm the sidecar
   launches. This should be an early implementation-plan task, not a late one, since a failure here
   changes the macOS build approach.
2. **Azure Artifact Signing's individual-developer eligibility** (§6) — worth a quick confirmation
   pass if Windows signing becomes a priority later; not blocking v1's unsigned default.
3. **The exact `tauri-action` input name for Windows updater-artifact preference** (`updaterJsonPreferNsis`
   or its current equivalent) should be confirmed against `tauri-action@v1`'s current README when the
   release workflow is actually written, since action inputs change across major versions.
4. **Windows ACL on the credentials file** — inherited from `%APPDATA%`, not set explicitly; carried
   over unresolved from the boundary spec's own open questions, not this design's to fix.
