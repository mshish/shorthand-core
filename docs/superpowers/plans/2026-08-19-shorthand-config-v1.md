# shorthand-config v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan scaffolds a brand-new repository — there is no existing branch to work from.** Task 1 creates the repo; every later task assumes it exists, is cloned locally, and is the working directory for that task's subagent.

**Goal:** Build v1 of `shorthand-config` — a Tauri 2.x desktop app that is the installable artifact, auto-updater, and Google OAuth consent flow for the Shorthand product line.

**Architecture:** A Rust/Tauri app that (a) bundles a compiled `shorthand-core` binary as a Tauri sidecar, (b) ports `shorthand-core`'s former OAuth consent flow (PKCE, authorization URL, loopback listener, token exchange, Drive/Docs container-doc creation) from its now-deleted TypeScript reference into native Rust modules under `src-tauri/src/google/`, (c) writes the credentials file directly per the ADC-aligned contract `shorthand-core` now reads, and (d) ships via a two-repo release split (private source, public releases) with a from-scratch minisign-signed updater pipeline across Windows, macOS (both architectures), and Linux.

**Tech Stack:** Tauri 2.11.5, `tauri-plugin-updater` 2.10.0, `tauri-plugin-opener`, `reqwest`, `tiny_http`, `sha2`/`base64`/`rand` (PKCE), `tempfile` (atomic writes), `serde`/`serde_json` (with `preserve_order`), React/TypeScript frontend, GitHub Actions + `tauri-action@v1`.

**Spec:** `docs/superpowers/specs/2026-08-19-shorthand-config-app-design.md` (this repo, until `shorthand-config` is scaffolded — Task 1 moves it). Also read `2026-08-19-shorthand-config-handoff.md`, `2026-08-19-shorthand-config-app-brief.md`, and `2026-08-19-google-oauth-boundary-design.md` in the same directory for background the design spec doesn't restate.

## Global Constraints

- Repository: `mshish/shorthand-config`, **private**. Releases publish to a separate **public** repo, `mshish/shorthand-config-releases`.
- `tauri = "2.11.5"`, `tauri-plugin-updater = "2.10.0"`, `@tauri-apps/api ^2.11.0` — pinned to match the Handy fork exactly, for consistency across the two apps.
- `tauri-action@v1` in CI, not `@v0`.
- `bundle.targets` is always an **explicit list**, never `"all"`.
- OAuth scope is `https://www.googleapis.com/auth/drive.file`, **never** combined with another scope, anywhere.
- The credentials file's four ADC fields (`type`, `client_id`, `client_secret`, `refresh_token`) plus `document_id`/`folder_id` are written in **exactly that key order**, `snake_case`, 2-space-indent JSON with a trailing newline — this is a byte-exact contract, verified by `shorthand-core`'s published conformance fixture (Task 14).
- Every credentials write is atomic: temp file in the **same directory**, then rename — never merged with an existing file (a write is a wholesale overwrite).
- `shorthand-core` is referenced at the pinned tag **`0.8.0`** (`mshish/shorthand-core@0.8.0`) until a later task explicitly re-pins it.
- Local dev secrets never go through Tauri/Vite's `.env` loading (that only reaches the frontend bundler) — build-time Rust secrets are real shell-exported environment variables or CI secrets, full stop.
- Distinct env var names for this app's OAuth client: `SHORTHAND_CONFIG_GOOGLE_CLIENT_ID` / `SHORTHAND_CONFIG_GOOGLE_CLIENT_SECRET` — never reuse `shorthand-core`'s `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` names.

---

### Task 1: Scaffold the repository

**Files:**
- Create: entire `shorthand-config` repo (new directory, e.g. `D:\tools\shorthand-config`)
- Move: `D:\tools\shorthand-core\docs\superpowers\specs\2026-08-19-shorthand-config-app-brief.md` → `shorthand-config/docs/2026-08-19-shorthand-config-app-brief.md`
- Move: `D:\tools\shorthand-core\docs\superpowers\specs\2026-08-19-shorthand-config-app-design.md` → `shorthand-config/docs/2026-08-19-shorthand-config-app-design.md`
- Delete (from `shorthand-core`, after copying): both files above, with a commit explaining the move

**Interfaces:**
- Produces: a pushed, private GitHub repo `mshish/shorthand-config` with a working `bun run tauri dev` scaffold, that every later task clones/works from.

- [ ] **Step 1: Scaffold via the official Tauri CLI**

```bash
cd D:\tools
bun create tauri-app shorthand-config
```

When prompted: identifier `com.shorthand.config`, frontend language TypeScript, package manager `bun`, UI template `React`, UI flavor `TypeScript`.

- [ ] **Step 2: Pin dependency versions to match the Handy fork**

Edit `shorthand-config/src-tauri/Cargo.toml`: set `tauri = "2.11.5"`. Edit `shorthand-config/package.json`: set `"@tauri-apps/api": "^2.11.0"`. Run `bun install` and `cd src-tauri && cargo update -p tauri --precise 2.11.5 && cd ..` to confirm the pin resolves.

- [ ] **Step 3: Verify the scaffold runs**

Run: `cd D:\tools\shorthand-config && bun run tauri build --debug --no-bundle`
Expected: a debug binary builds successfully with no errors (matches the Handy fork's own documented debug-build command).

- [ ] **Step 4: Move the two spec documents from shorthand-core into this repo**

```bash
mkdir -p D:\tools\shorthand-config\docs
cp "D:\tools\shorthand-core\docs\superpowers\specs\2026-08-19-shorthand-config-app-brief.md" "D:\tools\shorthand-config\docs\2026-08-19-shorthand-config-app-brief.md"
cp "D:\tools\shorthand-core\docs\superpowers\specs\2026-08-19-shorthand-config-app-design.md" "D:\tools\shorthand-config\docs\2026-08-19-shorthand-config-app-design.md"
```

Both files already say, in their own headers, that they live in `shorthand-core` "only because there is nowhere else to put it" and move once the repo exists — this step is that move.

- [ ] **Step 5: Delete the originals from shorthand-core and commit there**

```bash
cd D:\tools\shorthand-core
git rm docs/superpowers/specs/2026-08-19-shorthand-config-app-brief.md docs/superpowers/specs/2026-08-19-shorthand-config-app-design.md
git commit -m "docs: move shorthand-config's brief and design spec to their own repo

Both documents said, in their own headers, that they lived here only
because shorthand-config did not exist yet. It does now."
```

- [ ] **Step 6: Initialize git, commit, create the private GitHub repo, push**

```bash
cd D:\tools\shorthand-config
git init
git add -A
git commit -m "chore: scaffold shorthand-config from bun create tauri-app"
gh repo create mshish/shorthand-config --private --source=. --remote=origin
git push -u origin main
```

- [ ] **Step 7: Manual prerequisite — record for the human, do not attempt to automate**

This step cannot be done by an agent: create a GitHub Personal Access Token with `repo` scope (needed because `shorthand-core` is a private repo under the same personal account, not an org, so the default `GITHUB_TOKEN` can't read across repos), then run:

```bash
gh secret set CORE_REPO_PAT --repo mshish/shorthand-config
```

(paste the token when prompted). This secret is consumed starting in Task 3. Flag this to the human explicitly if it isn't already done before Task 3 starts.

---

### Task 2: Minimal CI — lint, typecheck, test across three OSes

**Files:**
- Create: `shorthand-config/.github/workflows/build.yml`

**Interfaces:**
- Consumes: the scaffold from Task 1.
- Produces: a green CI signal on every PR/push for all subsequent tasks — no secrets, no signing, no bundling.

- [ ] **Step 1: Write the workflow**

```yaml
name: Build

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
          - platform: macos-latest
          - platform: ubuntu-24.04
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - name: Install Linux Tauri build deps
        if: matrix.platform == 'ubuntu-24.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: bun install
      - run: bun run lint
      - run: cd src-tauri && cargo fmt --check
      - run: cd src-tauri && cargo clippy --all-targets -- -D warnings
      - run: cd src-tauri && cargo test
      - run: bun run build
      - run: bun run tauri build --debug --no-bundle
```

- [ ] **Step 2: Push and verify it runs green**

```bash
git add .github/workflows/build.yml
git commit -m "ci: add lint/typecheck/test workflow across Windows, macOS, Linux"
git push
gh run watch
```

Expected: all three matrix jobs pass. (`cargo test` currently has nothing to test yet — that's fine, it exits 0.)

---

### Task 3: `shorthand-core` sidecar — compile, bundle, verify on macOS

**This is the highest-risk task in the plan — do it early.** Bun issues #29120/#29270 documented a real regression (fixed by PR #29272) where `bun build --compile --target=bun-darwin-arm64` produced a truncated code signature that made macOS kill the binary on launch. This task is the actual test of whether that's resolved for this project, not something to assume from the Windows-verified result in the brief.

**Files:**
- Create: `shorthand-config/scripts/compile-core.sh`
- Create: `shorthand-config/src-tauri/binaries/.gitkeep` (the compiled binaries themselves are build output, gitignored)
- Modify: `shorthand-config/.gitignore` — add `src-tauri/binaries/*` except `.gitkeep`
- Modify: `shorthand-config/src-tauri/tauri.conf.json` — add `bundle.externalBin`
- Modify: `shorthand-config/src-tauri/capabilities/default.json` — grant sidecar execute permission
- Modify: `shorthand-config/.github/workflows/build.yml` — add a sidecar-compile-and-smoke-test step
- Create: `shorthand-config/src-tauri/src/sidecar.rs`
- Test: exercised via CI (this task's real "test" is a CI run, not a local one — see Step 5)

**Interfaces:**
- Produces: `sidecar::spawn_core(app: &tauri::AppHandle, args: &[&str]) -> Result<std::process::Output, String>` — used by nothing yet in v1, but callable and CI-proven.

- [ ] **Step 1: Write the compile script**

```bash
#!/usr/bin/env bash
# scripts/compile-core.sh — compiles the pinned shorthand-core into a Tauri sidecar
# binary for the CURRENT host platform. Run once per CI matrix leg (native build only —
# see the design spec's macOS section for why this is never cross-compiled).
set -euo pipefail

CORE_TAG="0.8.0"
CORE_DIR="$(mktemp -d)"
trap 'rm -rf "$CORE_DIR"' EXIT

git clone --depth 1 --branch "$CORE_TAG" \
  "https://x-access-token:${CORE_REPO_PAT}@github.com/mshish/shorthand-core.git" \
  "$CORE_DIR"

pushd "$CORE_DIR" >/dev/null
bun install
case "$(uname -s)-$(uname -m)" in
  MINGW*|MSYS*) TRIPLE="x86_64-pc-windows-msvc"; OUT="shorthand-notes-${TRIPLE}.exe" ;;
  Darwin-arm64) TRIPLE="aarch64-apple-darwin"; OUT="shorthand-notes-${TRIPLE}" ;;
  Darwin-x86_64) TRIPLE="x86_64-apple-darwin"; OUT="shorthand-notes-${TRIPLE}" ;;
  Linux-x86_64) TRIPLE="x86_64-unknown-linux-gnu"; OUT="shorthand-notes-${TRIPLE}" ;;
  *) echo "unsupported host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
bun build bin/shorthand-notes.ts --compile --outfile "$OUT"
popd >/dev/null

mkdir -p src-tauri/binaries
mv "$CORE_DIR/$OUT" "src-tauri/binaries/$OUT"
chmod +x "src-tauri/binaries/$OUT" 2>/dev/null || true
echo "compiled: src-tauri/binaries/$OUT"
```

```bash
chmod +x scripts/compile-core.sh
```

- [ ] **Step 2: Wire `bundle.externalBin` in `tauri.conf.json`**

```json
{
  "bundle": {
    "externalBin": ["binaries/shorthand-notes"]
  }
}
```

(Tauri appends the target-triple suffix and platform extension itself when resolving `externalBin` entries — the base name `binaries/shorthand-notes` is what's declared; the compile script above produces the exact suffixed filenames Tauri expects.)

- [ ] **Step 3: Grant sidecar execute permission**

Edit `src-tauri/capabilities/default.json`, add to `"permissions"`:

```json
"shell:allow-execute"
```

Add `tauri-plugin-shell` to `src-tauri/Cargo.toml` dependencies (`tauri-plugin-shell = "2"`) and register it in `src-tauri/src/lib.rs`'s builder chain: `.plugin(tauri_plugin_shell::init())`.

- [ ] **Step 4: Write the spawn wrapper and its test**

`src-tauri/src/sidecar.rs`:

```rust
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::Output;

/// Spawns the bundled shorthand-core sidecar and waits for it to exit.
/// Nothing in v1 calls this yet outside of the CI smoke test — it exists to prove
/// the bundling pipeline produces a working, spawnable binary before any feature
/// depends on it.
pub async fn spawn_core(app: &tauri::AppHandle, args: &[&str]) -> Result<Output, String> {
    let sidecar = app
        .shell()
        .sidecar("shorthand-notes")
        .map_err(|e| e.to_string())?;
    sidecar
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())
}
```

This can't be unit-tested without a bundled app context (it needs a real `tauri::AppHandle`), so its verification is the CI smoke test in Step 5, not a `cargo test`.

- [ ] **Step 5: Add the compile-and-smoke-test CI step, pin the Bun version**

Edit `.github/workflows/build.yml`, add after the `setup-bun` step on every matrix leg:

```yaml
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.13"   # >= the version containing bun#29272's fix — verify and bump if a newer advisory lands
      - name: Compile shorthand-core sidecar
        env:
          CORE_REPO_PAT: ${{ secrets.CORE_REPO_PAT }}
        run: bash scripts/compile-core.sh
      - name: Smoke-test the compiled sidecar runs
        shell: bash
        run: |
          BIN=$(ls src-tauri/binaries/shorthand-notes-* | head -1)
          "$BIN" bogus-command; test $? -eq 2   # runCli's usage() exit code for an unknown command
```

- [ ] **Step 6: Push, watch CI, and treat the macOS leg as the real answer**

```bash
git add scripts/compile-core.sh src-tauri/tauri.conf.json src-tauri/capabilities/default.json src-tauri/src/sidecar.rs src-tauri/Cargo.toml src-tauri/src/lib.rs .gitignore .github/workflows/build.yml
git commit -m "feat: bundle shorthand-core as a Tauri sidecar, compiled per-platform in CI"
git push
gh run watch
```

Expected: all three legs (Windows, macOS, Linux) pass, including the macOS smoke test actually launching the compiled binary without exit 137. **If the macOS leg fails with a killed-on-launch symptom, this is a real blocker** — bump the pinned Bun version and retry before proceeding to any later task; do not work around it by cross-compiling from Linux (see design spec §5 for why that doesn't avoid the same bug class).

---

### Task 4: PKCE challenge generation

**Files:**
- Create: `shorthand-config/src-tauri/src/google/mod.rs`
- Create: `shorthand-config/src-tauri/src/google/oauth.rs`
- Modify: `shorthand-config/src-tauri/Cargo.toml` — add `rand`, `sha2`, `base64`
- Modify: `shorthand-config/src-tauri/src/lib.rs` — add `mod google;`

**Interfaces:**
- Produces: `google::oauth::generate_pkce_challenge() -> PkceChallenge { code_verifier: String, code_challenge: String }`, consumed by Task 11.

- [ ] **Step 1: Add dependencies**

```toml
rand = "0.8"
sha2 = "0.10"
base64 = "0.22"
```

- [ ] **Step 2: Write the failing test**

`src-tauri/src/google/oauth.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};

    #[test]
    fn pkce_challenge_is_url_safe_and_verifiably_derived() {
        let challenge = generate_pkce_challenge();

        // RFC 7636: verifier must be 43-128 chars from the unreserved URL-safe alphabet.
        assert!(challenge.code_verifier.len() >= 43 && challenge.code_verifier.len() <= 128);
        assert!(!challenge.code_verifier.contains('+'));
        assert!(!challenge.code_verifier.contains('/'));
        assert!(!challenge.code_verifier.contains('='));

        // code_challenge must be exactly S256(code_verifier), base64url, no padding.
        let mut hasher = Sha256::new();
        hasher.update(challenge.code_verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(challenge.code_challenge, expected);
    }

    #[test]
    fn two_challenges_are_never_the_same() {
        let a = generate_pkce_challenge();
        let b = generate_pkce_challenge();
        assert_ne!(a.code_verifier, b.code_verifier);
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd src-tauri && cargo test pkce_challenge -- --nocapture`
Expected: FAIL — `generate_pkce_challenge` is not defined.

- [ ] **Step 4: Implement**

Add above the test module:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct PkceChallenge {
    pub code_verifier: String,
    pub code_challenge: String,
}

/// 32 random bytes, base64url-no-padding, is a 43-character verifier — the RFC 7636
/// minimum, and what google-auth-library's own generateCodeVerifierAsync() produces
/// (the function this replaces on the TypeScript side).
pub fn generate_pkce_challenge() -> PkceChallenge {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(bytes);

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

    PkceChallenge { code_verifier, code_challenge }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && cargo test pkce_challenge`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/google/oauth.rs src-tauri/src/google/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: port PKCE challenge generation from oauth.ts to Rust"
```

---

### Task 5: Authorization URL builder

**Files:**
- Modify: `shorthand-config/src-tauri/src/google/oauth.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure function).
- Produces: `google::oauth::build_authorization_url(options: &AuthorizationUrlOptions) -> String`, consumed by Task 11. `AuthorizationUrlOptions { client_id, redirect_uri, code_challenge, scope, use_picker }`.

- [ ] **Step 1: Add the `url` crate**

```toml
url = "2"
```

- [ ] **Step 2: Write the failing tests — one per non-obvious rule from the brief**

```rust
#[cfg(test)]
mod authorization_url_tests {
    use super::*;

    fn base_options(use_picker: bool) -> AuthorizationUrlOptions<'static> {
        AuthorizationUrlOptions {
            client_id: "test-client-id",
            redirect_uri: "http://127.0.0.1:8721/callback",
            code_challenge: "test-challenge",
            scope: "https://www.googleapis.com/auth/drive.file",
            use_picker,
        }
    }

    fn params(url: &str) -> std::collections::HashMap<String, String> {
        url::Url::parse(url).unwrap().query_pairs().into_owned().collect()
    }

    #[test]
    fn always_sets_offline_access_and_forces_a_fresh_consent_prompt() {
        // Rule 5: access_type=offline AND prompt=consent, every time — omitting either
        // silently breaks refresh-token issuance, and the failure only shows up on a
        // SECOND consent by an already-granted user, not in normal development.
        let url = build_authorization_url(&base_options(true));
        let p = params(&url);
        assert_eq!(p.get("access_type").unwrap(), "offline");
        assert_eq!(p.get("prompt").unwrap(), "consent");
    }

    #[test]
    fn uses_pkce_s256() {
        // Rule 6: PKCE, S256 specifically, verifier carried separately to token exchange.
        let url = build_authorization_url(&base_options(true));
        let p = params(&url);
        assert_eq!(p.get("code_challenge").unwrap(), "test-challenge");
        assert_eq!(p.get("code_challenge_method").unwrap(), "S256");
    }

    #[test]
    fn requests_only_drive_file_scope() {
        // Rule 7: drive.file only, never combined.
        let url = build_authorization_url(&base_options(true));
        let p = params(&url);
        assert_eq!(p.get("scope").unwrap(), "https://www.googleapis.com/auth/drive.file");
    }

    #[test]
    fn picker_flag_present_only_when_requested() {
        // Rule 4: trigger_onepick=true when there's something to pick; omitted entirely
        // (not "false") for the create flow, where there's nothing to pick yet.
        let with_picker = params(&build_authorization_url(&base_options(true)));
        assert_eq!(with_picker.get("trigger_onepick").unwrap(), "true");

        let without_picker = params(&build_authorization_url(&base_options(false)));
        assert!(without_picker.get("trigger_onepick").is_none());
    }

    #[test]
    fn carries_client_id_redirect_uri_and_response_type() {
        let url = build_authorization_url(&base_options(true));
        let p = params(&url);
        assert_eq!(p.get("client_id").unwrap(), "test-client-id");
        assert_eq!(p.get("redirect_uri").unwrap(), "http://127.0.0.1:8721/callback");
        assert_eq!(p.get("response_type").unwrap(), "code");
    }

    #[test]
    fn targets_googles_authorization_endpoint() {
        let url = build_authorization_url(&base_options(true));
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test authorization_url_tests`
Expected: FAIL — `AuthorizationUrlOptions`/`build_authorization_url` not defined.

- [ ] **Step 4: Implement**

```rust
pub struct AuthorizationUrlOptions<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub code_challenge: &'a str,
    pub scope: &'a str,
    /// Omit the Picker trigger when there's nothing to pick (the create flow).
    pub use_picker: bool,
}

pub fn build_authorization_url(options: &AuthorizationUrlOptions) -> String {
    let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .expect("static URL is always valid");
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("client_id", options.client_id);
        pairs.append_pair("redirect_uri", options.redirect_uri);
        pairs.append_pair("response_type", "code");
        pairs.append_pair("scope", options.scope);
        pairs.append_pair("access_type", "offline");
        pairs.append_pair("prompt", "consent");
        pairs.append_pair("code_challenge", options.code_challenge);
        pairs.append_pair("code_challenge_method", "S256");
        if options.use_picker {
            pairs.append_pair("trigger_onepick", "true");
        }
    }
    url.into()
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && cargo test authorization_url_tests`
Expected: PASS, all six tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/google/oauth.rs src-tauri/Cargo.toml
git commit -m "feat: port buildAuthorizationUrl, encoding every non-obvious query param rule"
```

---

### Task 6: Loopback redirect listener

**Files:**
- Modify: `shorthand-config/src-tauri/src/google/oauth.rs`
- Modify: `shorthand-config/src-tauri/Cargo.toml` — add `tiny_http`

**Interfaces:**
- Produces: `google::oauth::bind_loopback_server(port: u16) -> Result<tiny_http::Server, String>` and `google::oauth::listen_for_redirect(server: tiny_http::Server) -> Result<LoopbackResult, String>` where `LoopbackResult { code: String, picked_file_ids: Vec<String> }`. Consumed by Task 11. The bind/listen split exists so tests can bind to an OS-assigned port (`0`) and discover the real one, while production always binds the fixed redirect port.

- [ ] **Step 1: Add `tiny_http`**

```toml
tiny_http = "0.12"
```

- [ ] **Step 2: Write the failing tests**

```rust
#[cfg(test)]
mod loopback_tests {
    use super::*;
    use std::thread;

    #[test]
    fn returns_code_and_filters_empty_picked_ids() {
        // Rule: picked_file_ids is comma-separated and empty entries must be filtered —
        // a trailing comma or an entirely absent picker round-trip must not produce [""].
        let server = bind_loopback_server(0).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = thread::spawn(move || listen_for_redirect(server));

        let response = ureq::get(&format!(
            "http://127.0.0.1:{port}/callback?code=abc123&picked_file_ids=file1,file2,"
        ))
        .call()
        .unwrap();
        assert_eq!(response.status(), 200);

        let result = handle.join().unwrap().unwrap();
        assert_eq!(result.code, "abc123");
        assert_eq!(result.picked_file_ids, vec!["file1", "file2"]);
    }

    #[test]
    fn missing_code_is_an_error_but_still_responds_to_the_browser() {
        let server = bind_loopback_server(0).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = thread::spawn(move || listen_for_redirect(server));

        let response = ureq::get(&format!("http://127.0.0.1:{port}/callback?error=access_denied"))
            .call()
            .unwrap();
        assert_eq!(response.status(), 200);

        let result = handle.join().unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn no_picker_round_trip_yields_an_empty_list_not_a_list_with_one_empty_string() {
        let server = bind_loopback_server(0).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = thread::spawn(move || listen_for_redirect(server));

        ureq::get(&format!("http://127.0.0.1:{port}/callback?code=abc123"))
            .call()
            .unwrap();

        let result = handle.join().unwrap().unwrap();
        assert!(result.picked_file_ids.is_empty());
    }
}
```

Add `ureq = "2"` under `[dev-dependencies]` in `Cargo.toml` (a small synchronous HTTP client, used here only to drive the listener in tests — production code never uses it).

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test loopback_tests`
Expected: FAIL — functions not defined.

- [ ] **Step 4: Implement**

```rust
pub struct LoopbackResult {
    pub code: String,
    pub picked_file_ids: Vec<String>,
}

pub fn bind_loopback_server(port: u16) -> Result<tiny_http::Server, String> {
    tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| e.to_string())
}

/// Blocks until exactly one request arrives, responds, and shuts down — mirrors
/// oauth.ts's listenForRedirect, which is a one-shot HTTP server for exactly this
/// purpose. Call from a spawned thread; this is synchronous by design (tiny_http),
/// not async.
pub fn listen_for_redirect(server: tiny_http::Server) -> Result<LoopbackResult, String> {
    let request = server.recv().map_err(|e| e.to_string())?;

    let full_url = format!("http://127.0.0.1{}", request.url());
    let parsed = url::Url::parse(&full_url).map_err(|e| e.to_string())?;
    let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    let code = params.get("code").cloned();

    let body = if code.is_some() {
        "You may close this tab and return to Shorthand."
    } else {
        "Missing authorization code."
    };
    let response = tiny_http::Response::from_string(body).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap(),
    );
    let _ = request.respond(response);

    match code {
        None => Err(format!(
            "OAuth redirect missing code: {}",
            parsed.query().unwrap_or("")
        )),
        Some(code) => {
            let picked_file_ids = params
                .get("picked_file_ids")
                .map(|v| v.split(',').filter(|s| !s.is_empty()).map(String::from).collect())
                .unwrap_or_default();
            Ok(LoopbackResult { code, picked_file_ids })
        }
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && cargo test loopback_tests`
Expected: PASS, all three tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/google/oauth.rs src-tauri/Cargo.toml
git commit -m "feat: port listenForRedirect to a tiny_http loopback listener"
```

---

### Task 7: Token exchange and refresh

**Files:**
- Modify: `shorthand-config/src-tauri/src/google/oauth.rs`
- Modify: `shorthand-config/src-tauri/Cargo.toml` — add `reqwest`, `serde`, `wiremock` (dev)

**Interfaces:**
- Produces: `google::oauth::exchange_code(http, client_id, client_secret, code, code_verifier, redirect_uri) -> Result<String, String>` (returns the refresh token) and `google::oauth::refresh_access_token(http, client_id, client_secret, refresh_token) -> Result<String, String>` (returns an access token — needed because, unlike the TypeScript `OAuth2Client`, there is no auto-refreshing client wrapping subsequent Drive/Docs calls; Task 11's orchestration calls this explicitly right after exchange). Both consumed by Task 8 and Task 11.

- [ ] **Step 1: Add dependencies**

```toml
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
wiremock = "0.6"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

- [ ] **Step 2: Write the failing tests**

```rust
#[cfg(test)]
mod token_exchange_tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn exchange_returns_the_refresh_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "refresh_token": "rt", "expires_in": 3600
            })))
            .mount(&server)
            .await;

        let http = reqwest::Client::new();
        let refresh_token = exchange_code_at(
            &http, &server.uri(), "cid", "csecret", "code123", "verifier", "http://127.0.0.1:8721/callback",
        )
        .await
        .unwrap();
        assert_eq!(refresh_token, "rt");
    }

    #[tokio::test]
    async fn missing_refresh_token_fails_loudly_rather_than_returning_a_one_shot_credential() {
        // The rule from oauth.ts L68-70: a silent absence here produces a credential
        // that works exactly once. This must be a hard error, not an Option::None.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600
            })))
            .mount(&server)
            .await;

        let http = reqwest::Client::new();
        let result = exchange_code_at(
            &http, &server.uri(), "cid", "csecret", "code123", "verifier", "http://127.0.0.1:8721/callback",
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("refresh token"));
    }

    #[tokio::test]
    async fn refresh_returns_an_access_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "fresh-at", "expires_in": 3600
            })))
            .mount(&server)
            .await;

        let http = reqwest::Client::new();
        let access_token = refresh_access_token_at(&http, &server.uri(), "cid", "csecret", "rt")
            .await
            .unwrap();
        assert_eq!(access_token, "fresh-at");
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test token_exchange_tests`
Expected: FAIL — functions not defined.

- [ ] **Step 4: Implement**

Public functions hit Google's real endpoint; `_at` variants take an explicit base URL so tests can point at the mock server without needing a runtime env-var seam.

```rust
#[derive(serde::Deserialize)]
struct TokenResponse {
    refresh_token: Option<String>,
    access_token: Option<String>,
}

const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

pub async fn exchange_code(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    exchange_code_at(http, GOOGLE_TOKEN_ENDPOINT, client_id, client_secret, code, code_verifier, redirect_uri).await
}

async fn exchange_code_at(
    http: &reqwest::Client,
    endpoint: &str,
    client_id: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let response = http
        .post(format!("{endpoint}/token"))
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Google token exchange failed: {}", response.text().await.unwrap_or_default()));
    }
    let parsed: TokenResponse = response.json().await.map_err(|e| e.to_string())?;
    parsed.refresh_token.ok_or_else(|| {
        "Google did not return a refresh token — retry with prompt=consent (already set) on a fresh consent grant.".to_string()
    })
}

pub async fn refresh_access_token(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<String, String> {
    refresh_access_token_at(http, GOOGLE_TOKEN_ENDPOINT, client_id, client_secret, refresh_token).await
}

async fn refresh_access_token_at(
    http: &reqwest::Client,
    endpoint: &str,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<String, String> {
    let response = http
        .post(format!("{endpoint}/token"))
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Google token refresh failed: {}", response.text().await.unwrap_or_default()));
    }
    let parsed: TokenResponse = response.json().await.map_err(|e| e.to_string())?;
    parsed.access_token.ok_or_else(|| "Token refresh returned no access token".to_string())
}
```

Note: `endpoint` above is used as `{endpoint}/token`, but the mock server's `path("/token")` matcher expects the mock's base URI plus `/token` — when wiring this up, pass the mock's full URI (which wiremock's `server.uri()` already returns without a trailing path) as `endpoint`, matching `GOOGLE_TOKEN_ENDPOINT`'s shape (a bare origin, `/token` appended by the function). Adjust the real constant to `https://oauth2.googleapis.com` (no `/token` suffix) if this trips up during Step 3/5 iteration — the test itself, not this note, is the source of truth for the exact contract.

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && cargo test token_exchange_tests`
Expected: PASS, all three tests. Fix any endpoint-construction mismatch surfaced here per the note above.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/google/oauth.rs src-tauri/Cargo.toml
git commit -m "feat: port exchangeCode and add explicit refresh_access_token"
```

---

### Task 8: Container doc — Drive folder + Docs doc creation and reparent

**The single most error-prone piece, per the brief.** Three non-obvious rules apply here: (1) the reparent needs both `addParents` and `removeParents`, (2) the reparent runs even when the document already existed, (3) a failure after folder creation must name the orphaned folder in the error.

**Files:**
- Create: `shorthand-config/src-tauri/src/google/container_doc.rs`
- Modify: `shorthand-config/src-tauri/src/google/mod.rs` — add `mod container_doc;`

**Interfaces:**
- Consumes: `reqwest::Client`, an access token (from Task 7's `refresh_access_token`).
- Produces: `google::container_doc::ensure_container_doc(http, access_token, existing: ExistingTarget, options: ContainerDocOptions) -> Result<ContainerDocResult, String>` where `ExistingTarget { folder_id: Option<String>, document_id: Option<String> }`, `ContainerDocOptions { folder_name: Option<String>, doc_title: Option<String> }`, `ContainerDocResult { folder_id: String, document_id: String, folder_created: bool, document_created: bool }`. Consumed by Task 11.

- [ ] **Step 1: Write the failing tests against a mock Drive/Docs API**

```rust
#[cfg(test)]
mod container_doc_tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn both_ids_already_present_short_circuits_with_no_api_calls() {
        let server = MockServer::start().await; // no mocks registered — any call would 404
        let http = reqwest::Client::new();
        let result = ensure_container_doc_at(
            &http,
            &server.uri(),
            "token",
            ExistingTarget { folder_id: Some("f1".into()), document_id: Some("d1".into()) },
            ContainerDocOptions { folder_name: None, doc_title: None },
        )
        .await
        .unwrap();
        assert_eq!(result.folder_id, "f1");
        assert_eq!(result.document_id, "d1");
        assert!(!result.folder_created);
        assert!(!result.document_created);
    }

    #[tokio::test]
    async fn creates_folder_and_doc_and_reparents_with_both_add_and_remove_parents() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "new-folder"})))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/docs/v1/documents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"documentId": "new-doc"})))
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/drive/v3/files/new-doc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"parents": ["root"]})))
            .mount(&server).await;
        // The rule under test: addParents AND removeParents, both present, on the same call.
        Mock::given(method("PATCH")).and(path("/drive/v3/files/new-doc"))
            .and(query_param("addParents", "new-folder"))
            .and(query_param("removeParents", "root"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "new-doc"})))
            .mount(&server).await;

        let http = reqwest::Client::new();
        let result = ensure_container_doc_at(
            &http, &server.uri(), "token",
            ExistingTarget { folder_id: None, document_id: None },
            ContainerDocOptions { folder_name: Some("My Notes".into()), doc_title: None },
        ).await.unwrap();
        assert_eq!(result.folder_id, "new-folder");
        assert_eq!(result.document_id, "new-doc");
        assert!(result.folder_created);
        assert!(result.document_created);
    }

    #[tokio::test]
    async fn reparent_runs_even_when_the_document_already_existed() {
        // The rule that's easy to drop: guarding the reparent behind "did we just create
        // the doc" silently leaves a picker-selected pre-existing doc outside the folder.
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "new-folder"})))
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/drive/v3/files/existing-doc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"parents": ["somewhere-else"]})))
            .mount(&server).await;
        let reparent = Mock::given(method("PATCH")).and(path("/drive/v3/files/existing-doc"))
            .and(query_param("addParents", "new-folder"))
            .and(query_param("removeParents", "somewhere-else"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "existing-doc"})))
            .expect(1)
            .mount(&server).await;

        let http = reqwest::Client::new();
        let result = ensure_container_doc_at(
            &http, &server.uri(), "token",
            ExistingTarget { folder_id: None, document_id: Some("existing-doc".into()) },
            ContainerDocOptions { folder_name: None, doc_title: None },
        ).await.unwrap();
        assert!(!result.document_created);
        assert_eq!(result.document_id, "existing-doc");
        drop(reparent); // wiremock asserts .expect(1) was satisfied on drop
    }

    #[tokio::test]
    async fn a_failure_after_folder_creation_names_the_orphaned_folder() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "orphaned-folder-id"})))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/docs/v1/documents"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server).await;

        let http = reqwest::Client::new();
        let result = ensure_container_doc_at(
            &http, &server.uri(), "token",
            ExistingTarget { folder_id: None, document_id: None },
            ContainerDocOptions { folder_name: None, doc_title: None },
        ).await;
        let message = result.unwrap_err();
        assert!(message.contains("orphaned-folder-id"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test container_doc_tests`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Implement**

`src-tauri/src/google/container_doc.rs`:

```rust
const DEFAULT_NAME: &str = "Shorthand Meeting Notes";
const GOOGLE_API_BASE: &str = "https://www.googleapis.com";
const GOOGLE_DOCS_BASE: &str = "https://docs.googleapis.com";

pub struct ExistingTarget {
    pub folder_id: Option<String>,
    pub document_id: Option<String>,
}

pub struct ContainerDocOptions {
    pub folder_name: Option<String>,
    pub doc_title: Option<String>,
}

pub struct ContainerDocResult {
    pub folder_id: String,
    pub document_id: String,
    pub folder_created: bool,
    pub document_created: bool,
}

#[derive(serde::Deserialize)]
struct IdResponse {
    id: Option<String>,
}
#[derive(serde::Deserialize)]
struct DocsCreateResponse {
    #[serde(rename = "documentId")]
    document_id: Option<String>,
}
#[derive(serde::Deserialize)]
struct ParentsResponse {
    parents: Option<Vec<String>>,
}

pub async fn ensure_container_doc(
    http: &reqwest::Client,
    access_token: &str,
    existing: ExistingTarget,
    options: ContainerDocOptions,
) -> Result<ContainerDocResult, String> {
    ensure_container_doc_at(http, GOOGLE_API_BASE, access_token, existing, options).await
}

async fn ensure_container_doc_at(
    http: &reqwest::Client,
    drive_base: &str,
    access_token: &str,
    existing: ExistingTarget,
    options: ContainerDocOptions,
) -> Result<ContainerDocResult, String> {
    if let (Some(folder_id), Some(document_id)) = (&existing.folder_id, &existing.document_id) {
        return Ok(ContainerDocResult {
            folder_id: folder_id.clone(),
            document_id: document_id.clone(),
            folder_created: false,
            document_created: false,
        });
    }

    let name = options.folder_name.as_deref().unwrap_or(DEFAULT_NAME);
    let (folder_id, folder_created) = match &existing.folder_id {
        Some(id) => (id.clone(), false),
        None => {
            let response = http
                .post(format!("{drive_base}/drive/v3/files"))
                .bearer_auth(access_token)
                .json(&serde_json::json!({ "name": name, "mimeType": "application/vnd.google-apps.folder" }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let body: IdResponse = response.json().await.map_err(|e| e.to_string())?;
            (body.id.ok_or("Drive API created a folder but returned no id")?, true)
        }
    };

    match ensure_document_and_reparent(http, drive_base, access_token, &existing, &options, &folder_id).await {
        Ok((document_id, document_created)) => {
            Ok(ContainerDocResult { folder_id, document_id, folder_created, document_created })
        }
        Err(message) => Err(if folder_created {
            format!(
                "{message} (a Drive folder was already created before this failure — id: {folder_id}; \
                 check Google Drive and either reuse or delete it before retrying, to avoid creating another one)"
            )
        } else {
            message
        }),
    }
}

/// Runs the reparent whenever this is reached — even when the document already
/// existed. A picker-flow user (documentId only, no folder) later running the create
/// flow still needs their pre-existing document moved into the new folder; guarding
/// this behind "did we just create the doc" is the natural mistake.
async fn ensure_document_and_reparent(
    http: &reqwest::Client,
    drive_base: &str,
    access_token: &str,
    existing: &ExistingTarget,
    options: &ContainerDocOptions,
    folder_id: &str,
) -> Result<(String, bool), String> {
    let (document_id, document_created) = match &existing.document_id {
        Some(id) => (id.clone(), false),
        None => {
            let title = options.doc_title.as_deref().or(options.folder_name.as_deref()).unwrap_or(DEFAULT_NAME);
            let response = http
                .post(format!("{GOOGLE_DOCS_BASE}/docs/v1/documents").replace(GOOGLE_DOCS_BASE, drive_base))
                .bearer_auth(access_token)
                .json(&serde_json::json!({ "title": title }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let body: DocsCreateResponse = response.json().await.map_err(|e| e.to_string())?;
            (body.document_id.ok_or("Docs API created a document but returned no documentId")?, true)
        }
    };

    // Google's files.update docs: a file has exactly one parent, and moving it requires
    // BOTH addParents and removeParents on the same call — addParents alone either fails
    // or produces the multi-parent state Google doesn't support. Every file reaching here
    // already has a parent (My Drive root for a fresh doc; wherever the user keeps it for
    // a picker-selected one), so fetch current parents first.
    let current = http
        .get(format!("{drive_base}/drive/v3/files/{document_id}?fields=parents"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let current_parents: ParentsResponse = current.json().await.map_err(|e| e.to_string())?;
    let remove_parents = current_parents.parents.filter(|p| !p.is_empty()).map(|p| p.join(","));

    let mut update_url = url::Url::parse(&format!("{drive_base}/drive/v3/files/{document_id}"))
        .map_err(|e| e.to_string())?;
    {
        let mut pairs = update_url.query_pairs_mut();
        pairs.append_pair("addParents", folder_id);
        pairs.append_pair("fields", "id");
        if let Some(remove) = &remove_parents {
            pairs.append_pair("removeParents", remove);
        }
    }
    http.patch(update_url).bearer_auth(access_token).send().await.map_err(|e| e.to_string())?;

    Ok((document_id, document_created))
}
```

Note the `.replace(GOOGLE_DOCS_BASE, drive_base)` hack in the doc-create URL: it exists only to route the mock server's single base URI to both the Drive and Docs endpoints in tests, since real Google splits them across two hosts. Replace it with a straightforward `format!("{drive_base}/docs/v1/documents")` once tests pass — the docs endpoint's mock in Step 1 uses `path("/docs/v1/documents")` against the same single mock server origin, so a plain `format!` against `drive_base` already works; simplify this during Step 3/4 rather than shipping the `.replace` workaround.

- [ ] **Step 4: Run to verify it passes, simplify the URL construction, re-run**

Run: `cd src-tauri && cargo test container_doc_tests`
Expected: PASS, all four tests, after removing the `.replace` workaround noted above.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/google/container_doc.rs src-tauri/src/google/mod.rs
git commit -m "feat: port ensureContainerDoc — reparent with addParents+removeParents, orphaned-folder error"
```

---

### Task 9: Credentials writer

**Files:**
- Create: `shorthand-config/src-tauri/src/google/credentials.rs`
- Modify: `shorthand-config/src-tauri/src/google/mod.rs` — add `mod credentials;`
- Modify: `shorthand-config/src-tauri/Cargo.toml` — add `tempfile`; **change `serde_json` to enable `preserve_order`**

**Interfaces:**
- Produces: `google::credentials::credentials_path() -> PathBuf`, `google::credentials::Credentials { client_id, client_secret, refresh_token, document_id: Option<String>, folder_id: Option<String> }`, `google::credentials::write_credentials(path: &Path, credentials: &Credentials) -> std::io::Result<()>`. Consumed by Task 11, Task 14, and by the test-only CLI subcommand in Task 14.

- [ ] **Step 1: Add and fix dependencies**

```toml
tempfile = "3"
# serde_json's Map is a BTreeMap (alphabetical) by default — that silently reorders keys
# and breaks the byte-exact conformance fixture. preserve_order makes it insertion-ordered.
serde_json = { version = "1", features = ["preserve_order"] }
```

- [ ] **Step 2: Write the failing tests, using shorthand-core's own golden bytes**

These are transcribed exactly from `shorthand-core/src/testing/google-credentials-conformance.ts`'s `GOOGLE_CREDENTIALS_FIXTURES` — the same bytes Task 14's conformance suite will check independently, caught here first at unit-test speed.

```rust
#[cfg(test)]
mod credentials_tests {
    use super::*;
    use std::fs;

    fn minimal() -> Credentials {
        Credentials {
            client_id: "1234567890-conformance.apps.googleusercontent.com".into(),
            client_secret: "conformance-client-secret".into(),
            refresh_token: "conformance-refresh-token".into(),
            document_id: Some("conformance-document-id".into()),
            folder_id: None,
        }
    }

    #[test]
    fn matches_the_golden_bytes_for_the_minimal_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-credentials.json");
        write_credentials(&path, &minimal()).unwrap();

        let expected = "{\n  \"type\": \"authorized_user\",\n  \"client_id\": \"1234567890-conformance.apps.googleusercontent.com\",\n  \"client_secret\": \"conformance-client-secret\",\n  \"refresh_token\": \"conformance-refresh-token\",\n  \"document_id\": \"conformance-document-id\"\n}\n";
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    }

    #[test]
    fn matches_the_golden_bytes_with_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-credentials.json");
        let mut creds = minimal();
        creds.folder_id = Some("conformance-folder-id".into());
        write_credentials(&path, &creds).unwrap();

        let expected = "{\n  \"type\": \"authorized_user\",\n  \"client_id\": \"1234567890-conformance.apps.googleusercontent.com\",\n  \"client_secret\": \"conformance-client-secret\",\n  \"refresh_token\": \"conformance-refresh-token\",\n  \"document_id\": \"conformance-document-id\",\n  \"folder_id\": \"conformance-folder-id\"\n}\n";
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    }

    #[test]
    fn omits_absent_optional_fields_entirely_rather_than_writing_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-credentials.json");
        let mut creds = minimal();
        creds.document_id = None;
        write_credentials(&path, &creds).unwrap();

        let expected = "{\n  \"type\": \"authorized_user\",\n  \"client_id\": \"1234567890-conformance.apps.googleusercontent.com\",\n  \"client_secret\": \"conformance-client-secret\",\n  \"refresh_token\": \"conformance-refresh-token\"\n}\n";
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    }

    #[test]
    fn a_second_write_wholesale_overwrites_the_first_not_merges() {
        // Pins the deletion of mergeCredentials: a writer that helpfully preserves a
        // field the second write omits has reintroduced the merge — the exact class of
        // silent data loss the redesign removed.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-credentials.json");
        let mut with_folder = minimal();
        with_folder.folder_id = Some("conformance-folder-id".into());
        write_credentials(&path, &with_folder).unwrap();

        write_credentials(&path, &minimal()).unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        assert!(!contents.contains("folder_id"));
    }

    #[test]
    fn writes_leave_no_temp_file_debris() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-credentials.json");
        write_credentials(&path, &minimal()).unwrap();
        write_credentials(&path, &minimal()).unwrap();

        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].to_str().unwrap(), "google-credentials.json");
    }

    #[test]
    #[cfg(not(windows))]
    fn file_mode_is_0600_on_posix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("google-credentials.json");
        write_credentials(&path, &minimal()).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn credentials_path_uses_shorthands_own_platform_convention() {
        // Mirrors shorthand-core's config.ts shorthandConfigDirectory exactly — same
        // env vars, same "Shorthand" casing on Windows/macOS vs lowercase on Linux XDG —
        // because this path must resolve identically to core's own credentialsPath().
        let path = credentials_path();
        assert!(path.ends_with("google-credentials.json"));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test credentials_tests`
Expected: FAIL — module/functions not defined.

- [ ] **Step 4: Implement**

```rust
use std::env;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Credentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub document_id: Option<String>,
    pub folder_id: Option<String>,
}

/// Mirrors shorthand-core's src/config.ts shorthandConfigDirectory exactly, including
/// the Windows/macOS "Shorthand" vs Linux XDG lowercase "shorthand" split — this path
/// must resolve to the identical location core's own credentialsPath() computes.
pub fn shorthand_config_directory() -> PathBuf {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .unwrap_or_default();
    if cfg!(target_os = "windows") {
        let appdata = env::var("APPDATA").unwrap_or_else(|_| format!("{home}\\AppData\\Roaming"));
        PathBuf::from(appdata).join("Shorthand")
    } else if cfg!(target_os = "macos") {
        PathBuf::from(home).join("Library").join("Application Support").join("Shorthand")
    } else {
        let xdg = env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
        PathBuf::from(xdg).join("shorthand")
    }
}

pub fn credentials_path() -> PathBuf {
    shorthand_config_directory().join("google-credentials.json")
}

/// Writes the credentials file atomically (temp file in the same directory, then
/// rename) and wholesale — every write fully replaces the file's contents, matching
/// the "no merge" contract. Field order (type, client_id, client_secret, refresh_token,
/// document_id, folder_id) is part of the byte-exact contract; do not reorder.
pub fn write_credentials(path: &Path, credentials: &Credentials) -> std::io::Result<()> {
    let dir = path.parent().expect("credentials path must have a parent directory");
    std::fs::create_dir_all(dir)?;

    let mut map = serde_json::Map::new();
    map.insert("type".into(), serde_json::json!("authorized_user"));
    map.insert("client_id".into(), serde_json::json!(credentials.client_id));
    map.insert("client_secret".into(), serde_json::json!(credentials.client_secret));
    map.insert("refresh_token".into(), serde_json::json!(credentials.refresh_token));
    if let Some(document_id) = &credentials.document_id {
        map.insert("document_id".into(), serde_json::json!(document_id));
    }
    if let Some(folder_id) = &credentials.folder_id {
        map.insert("folder_id".into(), serde_json::json!(folder_id));
    }

    let mut body = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .expect("credentials always serialize");
    body.push('\n');

    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(body.as_bytes())?;
    temp.flush()?;

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o600))?;
    }

    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && cargo test credentials_tests`
Expected: PASS, all seven tests (six on Windows, where the POSIX-mode test is compiled out).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/google/credentials.rs src-tauri/src/google/mod.rs src-tauri/Cargo.toml
git commit -m "feat: write the ADC-aligned credentials file — atomic, wholesale, byte-exact"
```

---

### Task 10: OAuth client secret embedding

**Files:**
- Create: `shorthand-config/src-tauri/src/google/client.rs`
- Modify: `shorthand-config/src-tauri/src/google/mod.rs` — add `mod client;`
- Modify: `shorthand-config/.github/workflows/build.yml` — no change needed yet (release-only secrets land in Task 15); add a placeholder-detection guard here instead

**Interfaces:**
- Produces: `google::client::GOOGLE_CLIENT_ID: &str`, `google::client::GOOGLE_CLIENT_SECRET: &str`, consumed by Task 11.

- [ ] **Step 1: Write the module**

```rust
// The values below are read at COMPILE TIME from the environment — this is env!(), not
// std::env::var() — so a release build missing either variable fails to compile rather
// than shipping a binary with an empty secret. See the design spec §3 for why these are
// distinctly named from shorthand-core's own GOOGLE_OAUTH_CLIENT_ID/_SECRET: different
// owner, different purpose, and reusing the name would read as though they're the same
// concern when they're opposite ends of the one-way shorthand-config -> shorthand-core
// dependency.
pub const GOOGLE_CLIENT_ID: &str = env!("SHORTHAND_CONFIG_GOOGLE_CLIENT_ID");
pub const GOOGLE_CLIENT_SECRET: &str = env!("SHORTHAND_CONFIG_GOOGLE_CLIENT_SECRET");
```

- [ ] **Step 2: Set up local development so `cargo build`/`bun run tauri dev` compiles**

Create `shorthand-config/.env.local.example` (committed, a template only):

```
SHORTHAND_CONFIG_GOOGLE_CLIENT_ID=your-dev-client-id.apps.googleusercontent.com
SHORTHAND_CONFIG_GOOGLE_CLIENT_SECRET=your-dev-client-secret
```

Add `.env.local` to `.gitignore`. Document in `shorthand-config/README.md` (create it) under a "Local development" heading: copy `.env.local.example` to `.env.local`, `export $(cat .env.local | xargs)` (or the shell-appropriate equivalent) before running `bun run tauri dev` — this is a real shell export reaching `cargo build`'s environment, not Tauri/Vite's own `.env` loading, which only reaches the frontend bundler and never `env!()`.

- [ ] **Step 3: Verify the compile-time failure is real**

Run (with the two env vars deliberately unset): `cd src-tauri && cargo build`
Expected: FAIL with an error naming `SHORTHAND_CONFIG_GOOGLE_CLIENT_ID` as an unset environment variable — this is the intended behavior, not a bug to fix.

Run (with both env vars set to placeholder values): `SHORTHAND_CONFIG_GOOGLE_CLIENT_ID=x SHORTHAND_CONFIG_GOOGLE_CLIENT_SECRET=y cargo build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/google/client.rs src-tauri/src/google/mod.rs .env.local.example .gitignore README.md
git commit -m "feat: embed the OAuth client id/secret via env!() at compile time"
```

---

### Task 11: Login orchestration and Tauri commands

**Files:**
- Create: `shorthand-config/src-tauri/src/google/login_flow.rs`
- Modify: `shorthand-config/src-tauri/src/google/mod.rs` — add `mod login_flow;`
- Modify: `shorthand-config/src-tauri/src/lib.rs` — register commands, add `tauri-plugin-opener`
- Modify: `shorthand-config/src-tauri/Cargo.toml` — add `tauri-plugin-opener`
- Modify: `shorthand-config/src-tauri/capabilities/default.json` — grant `opener:default`

**Interfaces:**
- Consumes: every module from Tasks 4–10.
- Produces: two `#[tauri::command]`s — `connect_google(create_mode: bool) -> Result<ConnectionStatus, String>` and `get_connection_status() -> ConnectionStatus`, where `ConnectionStatus { connected: bool, document_id: Option<String> }`. Consumed by Task 12 (frontend).

- [ ] **Step 1: Add `tauri-plugin-opener` and register it**

```toml
tauri-plugin-opener = "2"
```

In `src-tauri/src/lib.rs`'s builder chain: `.plugin(tauri_plugin_opener::init())`. In `capabilities/default.json`'s `"permissions"`, add `"opener:default"`.

- [ ] **Step 2: Write the orchestration, matching runGoogleLogin's shape**

`src-tauri/src/google/login_flow.rs`:

```rust
use crate::google::{client, container_doc, credentials, oauth};
use std::thread;

const REDIRECT_PORT: u16 = 8721;

pub struct ConnectionStatus {
    pub connected: bool,
    pub document_id: Option<String>,
}

/// Mirrors runGoogleLogin (bin/shorthand-notes.ts, pre-deletion) step for step: PKCE ->
/// authorization URL -> open browser -> listen for the loopback redirect -> exchange the
/// code -> refresh once for an access token -> create-or-pick the target -> write the
/// credentials file. `create_mode` selects the picker flow (false) vs the create flow
/// (true) — see oauth.rs's `use_picker` for why these are mutually exclusive.
pub async fn run_google_login(app: &tauri::AppHandle, create_mode: bool) -> Result<ConnectionStatus, String> {
    let redirect_uri = format!("http://127.0.0.1:{REDIRECT_PORT}/callback");
    let challenge = oauth::generate_pkce_challenge();
    let authorization_url = oauth::build_authorization_url(&oauth::AuthorizationUrlOptions {
        client_id: client::GOOGLE_CLIENT_ID,
        redirect_uri: &redirect_uri,
        code_challenge: &challenge.code_challenge,
        scope: crate::google::scope::GOOGLE_DOCS_SCOPE,
        use_picker: !create_mode,
    });

    let server = oauth::bind_loopback_server(REDIRECT_PORT)?;

    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(&authorization_url, None::<&str>).map_err(|e| e.to_string())?;

    let redirect = thread::spawn(move || oauth::listen_for_redirect(server))
        .join()
        .map_err(|_| "loopback listener thread panicked".to_string())??;

    let http = reqwest::Client::new();
    let refresh_token = oauth::exchange_code(
        &http, client::GOOGLE_CLIENT_ID, client::GOOGLE_CLIENT_SECRET,
        &redirect.code, &challenge.code_verifier, &redirect_uri,
    ).await?;
    let access_token = oauth::refresh_access_token(
        &http, client::GOOGLE_CLIENT_ID, client::GOOGLE_CLIENT_SECRET, &refresh_token,
    ).await?;

    let existing_path = credentials::credentials_path();

    let (document_id, folder_id) = if create_mode {
        let result = container_doc::ensure_container_doc(
            &http, &access_token,
            container_doc::ExistingTarget { folder_id: None, document_id: None },
            container_doc::ContainerDocOptions { folder_name: None, doc_title: None },
        ).await?;
        (result.document_id, Some(result.folder_id))
    } else {
        let picked = redirect.picked_file_ids.first().cloned()
            .ok_or("No document was picked. Reconnect and choose a Google Doc.")?;
        (picked, None)
    };

    credentials::write_credentials(&existing_path, &credentials::Credentials {
        client_id: client::GOOGLE_CLIENT_ID.to_string(),
        client_secret: client::GOOGLE_CLIENT_SECRET.to_string(),
        refresh_token,
        document_id: Some(document_id.clone()),
        folder_id,
    }).map_err(|e| e.to_string())?;

    Ok(ConnectionStatus { connected: true, document_id: Some(document_id) })
}
```

Also create `src-tauri/src/google/scope.rs` holding the duplicated scope constant (needed now, and anchors the scope guard in Task 13):

```rust
// Duplicated from shorthand-core's GOOGLE_DOCS_SCOPE (src/google/docs-sink.ts), not
// imported — importing it would mean this Rust app taking a build dependency on core's
// raw-TypeScript export map for one string literal, the forbidden dependency direction
// in miniature. Safe BECAUSE both repos' scope guards exist and run in CI (this app's
// guard: Task 13; core's: test/google-scope-guard.test.ts) — an unnoticed divergence
// becomes a test failure on whichever side drifts, rather than a silent scope widening.
pub const GOOGLE_DOCS_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
```

Add `mod scope;` to `google/mod.rs`.

- [ ] **Step 3: Add the Tauri commands**

Append to `login_flow.rs`:

```rust
#[tauri::command]
pub async fn connect_google(app: tauri::AppHandle, create_mode: bool) -> Result<ConnectionStatusDto, String> {
    let status = run_google_login(&app, create_mode).await?;
    Ok(ConnectionStatusDto { connected: status.connected, document_id: status.document_id })
}

#[tauri::command]
pub fn get_connection_status() -> ConnectionStatusDto {
    match credentials::read_credentials_for_status() {
        Some(creds) => ConnectionStatusDto { connected: true, document_id: creds.document_id },
        None => ConnectionStatusDto { connected: false, document_id: None },
    }
}

// Tauri auto-converts camelCase JS invoke ARGUMENTS to snake_case Rust parameter names
// (create_mode above), but does NOT apply the same conversion to return-value
// serialization — that's plain serde. Without rename_all here, this would serialize as
// `document_id`, silently breaking Task 12's frontend `status.documentId` read.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatusDto {
    pub connected: bool,
    pub document_id: Option<String>,
}
```

Add `read_credentials_for_status` to `credentials.rs` (Task 9's module) — a small reader used only for the connected-state UI, distinct from the writer:

```rust
/// Reads back the file this app just wrote, to render "connected to Google, targeting
/// document X". Per the boundary spec, one-writer-per-file governs writes, not reads —
/// a reader that only displays state does not violate it.
pub fn read_credentials_for_status() -> Option<Credentials> {
    let path = credentials_path();
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if parsed.get("type")?.as_str()? != "authorized_user" {
        return None;
    }
    Some(Credentials {
        client_id: parsed.get("client_id")?.as_str()?.to_string(),
        client_secret: parsed.get("client_secret")?.as_str()?.to_string(),
        refresh_token: parsed.get("refresh_token")?.as_str()?.to_string(),
        document_id: parsed.get("document_id").and_then(|v| v.as_str()).map(String::from),
        folder_id: parsed.get("folder_id").and_then(|v| v.as_str()).map(String::from),
    })
}
```

- [ ] **Step 4: Register the commands in `lib.rs`**

```rust
.invoke_handler(tauri::generate_handler![
    google::login_flow::connect_google,
    google::login_flow::get_connection_status,
])
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: PASS (with the dev env vars from Task 10 Step 2 exported).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/google/login_flow.rs src-tauri/src/google/scope.rs src-tauri/src/google/credentials.rs src-tauri/src/google/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/capabilities/default.json
git commit -m "feat: wire the full login orchestration and expose it as Tauri commands"
```

---

### Task 12: Frontend — connect button and status

**Files:**
- Modify: `shorthand-config/src/App.tsx`
- Create: `shorthand-config/src/components/ConnectGoogle.tsx`

**Interfaces:**
- Consumes: `connect_google(create_mode: boolean)` and `get_connection_status()` from Task 11 via `@tauri-apps/api/core`'s `invoke`.

- [ ] **Step 1: Write the component**

`src/components/ConnectGoogle.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ConnectionStatus = { connected: boolean; documentId?: string };

export function ConnectGoogle() {
  const [status, setStatus] = useState<ConnectionStatus>({ connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ConnectionStatus>("get_connection_status").then(setStatus);
  }, []);

  async function connect(createMode: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<ConnectionStatus>("connect_google", { createMode });
      setStatus(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.connected) {
    return <p>Connected to Google. Target document: {status.documentId}</p>;
  }

  return (
    <div>
      <button disabled={busy} onClick={() => connect(false)}>
        Connect Google (choose an existing doc)
      </button>
      <button disabled={busy} onClick={() => connect(true)}>
        Connect Google (create a new doc)
      </button>
      {error !== null && <p role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `App.tsx`**

Replace the scaffold's default content with:

```tsx
import { ConnectGoogle } from "./components/ConnectGoogle";

function App() {
  return (
    <main>
      <h1>Shorthand Config</h1>
      <ConnectGoogle />
    </main>
  );
}

export default App;
```

- [ ] **Step 3: Verify it builds and runs**

Run: `bun run build`
Expected: PASS, no TypeScript errors.

Run: `bun run tauri dev` (with Task 10's dev env vars exported), click both connect buttons.
Expected: the system browser opens to Google's consent screen for each. A real end-to-end click-through against a real Google account is **not** required to pass this task — that belongs to Task 17's verification checklist, since it needs a registered OAuth client (a manual, human step per Task 10).

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/ConnectGoogle.tsx
git commit -m "feat: add the connect-Google UI and wire it to the backend commands"
```

---

### Task 13: Scope guard

**Files:**
- Create: `shorthand-config/src-tauri/src/google/scope_guard_test.rs`
- Modify: `shorthand-config/src-tauri/src/google/mod.rs` — add `#[cfg(test)] mod scope_guard_test;`

**Interfaces:**
- Consumes: nothing (a standalone repo-scanning test).
- Produces: nothing consumed elsewhere — a CI gate.

- [ ] **Step 1: Write the test, including its own mutation-verification harness**

```rust
use std::fs;
use std::path::{Path, PathBuf};

fn source_files(root: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().and_then(|n| n.to_str()) == Some("target") { continue; }
                out.extend(source_files(&path, extensions));
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if extensions.contains(&ext) { out.push(path); }
            }
        }
    }
    out
}

fn scope_matches(content: &str) -> Vec<String> {
    // Deliberately hand-rolled instead of pulling in a regex crate for one pattern: finds
    // "googleapis.com/auth/" and reads the run of scope-identifier characters after it.
    let needle = "googleapis.com/auth/";
    let mut matches = Vec::new();
    let mut search_from = 0;
    while let Some(offset) = content[search_from..].find(needle) {
        let start = search_from + offset;
        let after = &content[start + needle.len()..];
        let end = after.find(|c: char| !(c.is_alphanumeric() || c == '.' || c == '_')).unwrap_or(after.len());
        matches.push(format!("googleapis.com/auth/{}", &after[..end]));
        search_from = start + needle.len();
    }
    matches
}

#[test]
fn no_source_file_requests_a_scope_other_than_drive_file() {
    // Walks src-tauri/**/*.rs AND src/**/*.{ts,tsx} — a literal copy of core's TS-only
    // guard would scan only the frontend here, find zero matches, and pass vacuously.
    let mut files = source_files(Path::new("src"), &["rs"]);
    files.extend(source_files(Path::new("../src"), &["ts", "tsx"]));

    let mut offenders = Vec::new();
    for file in &files {
        let content = fs::read_to_string(file).unwrap_or_default();
        for m in scope_matches(&content) {
            if m != "googleapis.com/auth/drive.file" {
                offenders.push(format!("{}: {}", file.display(), m));
            }
        }
    }
    assert!(offenders.is_empty(), "unexpected OAuth scope(s): {offenders:?}");
}

#[test]
fn drive_file_is_still_present_anchored_on_the_authorization_url_builder() {
    // The negative test above passes on zero matches too — this is what tells "correctly
    // scoped" apart from "the scope code left the building". Anchored specifically on
    // scope.rs, the file login_flow.rs actually reads GOOGLE_DOCS_SCOPE from.
    let anchor = Path::new("src/google/scope.rs");
    let content = fs::read_to_string(anchor).expect("scope.rs must exist");
    let matches = scope_matches(&content);
    assert_eq!(matches, vec!["googleapis.com/auth/drive.file".to_string()]);
}
```

- [ ] **Step 2: Run to verify it passes against the real tree**

Run: `cd src-tauri && cargo test --test scope_guard_test 2>&1 || cargo test scope_guard`
Expected: PASS, both tests, against the actual `scope.rs` written in Task 11.

- [ ] **Step 3: Verify by mutation — the whole point of this task**

Temporarily comment out the constant in `src-tauri/src/google/scope.rs` (replace its value with an empty string), run the guard test: the positive test must FAIL. Restore it.

Temporarily add a second scope in a `.rs` file under `src-tauri/` (e.g. append `// googleapis.com/auth/drive.readonly` to `scope.rs`), run the guard test: the negative test must FAIL. Remove it.

This mutation check is the task's real deliverable — record in the commit message that both directions were verified by hand, since the automated test alone can't prove it caught what it was designed to catch.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/google/scope_guard_test.rs src-tauri/src/google/mod.rs
git commit -m "test: port the OAuth scope guard to Rust, scanning both src-tauri/*.rs and src/*.tsx

Verified by mutation: removing the drive.file constant fails the positive
assertion; adding a second scope in a .rs file under src-tauri/ fails the
negative one — the case a literal TS-guard copy would miss entirely."
```

---

### Task 14: Credentials conformance fixture (CI-only)

**Files:**
- Modify: `shorthand-config/src-tauri/src/main.rs` — add the test-only `--test-write-credentials` subcommand
- Create: `shorthand-config/conformance/package.json`
- Create: `shorthand-config/conformance/run.ts`
- Modify: `shorthand-config/.github/workflows/build.yml` — add a conformance job

**Interfaces:**
- Consumes: `google::credentials::{Credentials, write_credentials, credentials_path}` from Task 9.
- Produces: a CI-only harness satisfying `shorthand-core/testing`'s `CredentialsWriterHarness` contract — nothing runtime consumes this.

- [ ] **Step 1: Add the test-only CLI subcommand**

`src-tauri/src/main.rs` (before the normal Tauri entry point):

```rust
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--test-write-credentials" {
        let payload: serde_json::Value =
            serde_json::from_str(&args[2]).expect("invalid JSON payload for --test-write-credentials");
        let credentials = shorthand_config_lib::google::credentials::Credentials {
            client_id: payload["client_id"].as_str().expect("client_id").to_string(),
            client_secret: payload["client_secret"].as_str().expect("client_secret").to_string(),
            refresh_token: payload["refresh_token"].as_str().expect("refresh_token").to_string(),
            document_id: payload.get("document_id").and_then(|v| v.as_str()).map(String::from),
            folder_id: payload.get("folder_id").and_then(|v| v.as_str()).map(String::from),
        };
        let path = shorthand_config_lib::google::credentials::credentials_path();
        shorthand_config_lib::google::credentials::write_credentials(&path, &credentials)
            .expect("write_credentials failed");
        println!("{}", path.display());
        std::process::exit(0);
    }
    shorthand_config_lib::run();
}
```

(This assumes `src-tauri/src/lib.rs` exposes a public `run()` — the standard `bun create tauri-app` scaffold shape, where `main.rs` is a thin wrapper calling `app_lib::run()`. If the scaffold instead inlines everything in `main.rs`, factor the Tauri builder into a `run()` function in `lib.rs` first, matching the scaffold convention Tauri itself generates.)

- [ ] **Step 2: Write the CI-only conformance runner**

`conformance/package.json`:

```json
{
  "name": "shorthand-config-conformance",
  "private": true,
  "type": "module",
  "dependencies": {
    "shorthand-core": "github:mshish/shorthand-core#0.8.0"
  }
}
```

`conformance/run.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  describeGoogleCredentialsConformance,
  type CredentialsWriterHarness,
} from "shorthand-core/testing";

const BINARY = process.env.SHORTHAND_CONFIG_BINARY;
if (BINARY === undefined) {
  throw new Error("SHORTHAND_CONFIG_BINARY must point at the compiled shorthand-config binary");
}

function createHarness(): Promise<CredentialsWriterHarness> {
  const scratchHome = mkdtempSync(join(tmpdir(), "shorthand-config-conformance-"));
  // Redirects credentialsPath() to an empty, harness-owned directory on every platform —
  // the same env vars core's own shorthandConfigDirectory() reads, and the same ones
  // this app's Rust credentials_path() reads, so both resolve identically.
  const env = {
    ...process.env,
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    APPDATA: scratchHome,
    XDG_CONFIG_HOME: scratchHome,
  };
  return Promise.resolve({
    write: async (credentials) => {
      const result = spawnSync(BINARY, ["--test-write-credentials", JSON.stringify(credentials)], { env });
      if (result.status !== 0) {
        throw new Error(`writer exited ${result.status}: ${result.stderr.toString()}`);
      }
      return result.stdout.toString().trim();
    },
    dispose: async () => rmSync(scratchHome, { recursive: true, force: true }),
  });
}

describeGoogleCredentialsConformance(
  { describe, test: Object.assign(test, { todo: test.todo }) },
  "shorthand-config Rust writer",
  createHarness,
  { posixPermissions: process.platform !== "win32" },
);
```

- [ ] **Step 3: Wire the CI job**

Add to `.github/workflows/build.yml`, after the existing steps on each matrix leg:

```yaml
      - name: Build release binary for conformance testing
        run: bun run tauri build --no-bundle
      - name: Install conformance harness deps
        working-directory: conformance
        env:
          CORE_REPO_PAT: ${{ secrets.CORE_REPO_PAT }}
        run: |
          git config --global url."https://x-access-token:${CORE_REPO_PAT}@github.com/".insteadOf "https://github.com/"
          bun install
      - name: Run credentials conformance suite
        working-directory: conformance
        shell: bash
        env:
          SHORTHAND_CONFIG_BINARY: ${{ runner.os == 'Windows' && '../src-tauri/target/release/shorthand-config.exe' || '../src-tauri/target/release/shorthand-config' }}
        run: bun run --bun node --test run.ts
```

- [ ] **Step 4: Push and verify green, including the mutation half locally first**

Before pushing, locally verify the suite actually catches a wrong writer: temporarily change `write_credentials` to skip the `document_id` field unconditionally, run the conformance suite against a local build, confirm the "bytes match golden fixture" scenario fails, then revert. This is the same "prove the check catches what it should" discipline as Task 13's mutation check, applied to a suite you didn't write yourself.

```bash
git add src-tauri/src/main.rs conformance/package.json conformance/run.ts .github/workflows/build.yml
git commit -m "test: run shorthand-core's published credentials conformance suite in CI

Verified locally that a deliberately wrong writer (omitting document_id)
fails the golden-bytes scenario before trusting this as a real gate."
git push
gh run watch
```

Expected: all three matrix legs pass, including the conformance job.

---

### Task 15: Release pipeline

**Files:**
- Modify: `shorthand-config/src-tauri/tauri.conf.json`
- Create: `shorthand-config/.github/workflows/release.yml`
- Modify: `shorthand-config/src-tauri/capabilities/default.json` — add `updater:default`

**Interfaces:**
- Produces: a `workflow_dispatch`-triggered release that builds, signs, and uploads installers for all five platform legs to `mshish/shorthand-config-releases`.

- [ ] **Step 1: Manual prerequisites — record for the human, cannot be automated**

Before this task's CI can run for real:
1. Create the public repo: `gh repo create mshish/shorthand-config-releases --public`.
2. Generate a **fresh** minisign keypair (never reuse the Handy fork's): `bun run tauri signer generate -- -w shorthand-config-signing.key`. Set the printed public key into `tauri.conf.json` in Step 2 below. Store the private key and its password as GitHub secrets on `mshish/shorthand-config` (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) via `gh secret set`, then **back the private key file up somewhere that survives losing this machine** — there is no recovery path.
3. Apple Developer Program enrollment ($99/yr) and a Developer ID Application certificate, exported as a base64 `.p12` — set as `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID` secrets.
4. A `GH_RELEASES_TOKEN` PAT with `repo` scope on `mshish/shorthand-config-releases`, since the default `GITHUB_TOKEN` in `shorthand-config`'s workflow can't push releases to a different private-account repo.

Flag explicitly to the human whichever of these aren't done yet before this task's CI step runs — steps 5/6 below will fail without them, and that's expected until they're supplied.

- [ ] **Step 2: Configure `tauri.conf.json`**

```json
{
  "bundle": {
    "createUpdaterArtifacts": true,
    "targets": ["nsis", "app", "dmg", "deb", "appimage", "rpm"]
  },
  "plugins": {
    "updater": {
      "pubkey": "PASTE_THE_GENERATED_PUBLIC_KEY_HERE",
      "endpoints": [
        "https://github.com/mshish/shorthand-config-releases/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

Add `"updater:default"` to `src-tauri/capabilities/default.json`'s `"permissions"`.

- [ ] **Step 3: Write `release.yml`**

```yaml
name: "Release"

on: workflow_dispatch

jobs:
  create-release:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    outputs:
      release-id: ${{ steps.create-release.outputs.result }}
      version: ${{ steps.get-version.outputs.version }}
    steps:
      - uses: actions/checkout@v5
      - name: Get version from tauri.conf.json
        id: get-version
        run: |
          VERSION=$(grep -o '"version": "[^"]*"' src-tauri/tauri.conf.json | cut -d'"' -f4)
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
      - name: Create draft release in the public releases repo
        id: create-release
        uses: actions/github-script@v9
        with:
          github-token: ${{ secrets.GH_RELEASES_TOKEN }}
          script: |
            const { data } = await github.rest.repos.createRelease({
              owner: "mshish",
              repo: "shorthand-config-releases",
              tag_name: `v${{ steps.get-version.outputs.version }}`,
              name: `v${{ steps.get-version.outputs.version }}`,
              draft: true,
              generate_release_notes: true,
            });
            return data.id;

  publish-tauri:
    permissions:
      contents: write
    needs: create-release
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: "--target aarch64-apple-darwin"
          - platform: macos-13
            args: "--target x86_64-apple-darwin"
          - platform: windows-latest
            args: ""
          - platform: ubuntu-22.04
            args: "--bundles deb"
          - platform: ubuntu-24.04
            args: "--bundles appimage,rpm"
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.13"
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Linux Tauri build deps
        if: contains(matrix.platform, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: bun install
      - name: Compile shorthand-core sidecar
        env:
          CORE_REPO_PAT: ${{ secrets.CORE_REPO_PAT }}
        run: bash scripts/compile-core.sh
      - name: import Apple Developer Certificate
        if: contains(matrix.platform, 'macos')
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
        run: |
          echo $APPLE_CERTIFICATE | base64 --decode > certificate.p12
          security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          security set-keychain-settings -t 3600 -u build.keychain
          security import certificate.p12 -k build.keychain -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" build.keychain
      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GH_RELEASES_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        with:
          releaseId: ${{ needs.create-release.outputs.release-id }}
          args: ${{ matrix.args }}
          owner: mshish
          repo: shorthand-config-releases
          updaterJsonPreferNsis: true
```

Confirm `updaterJsonPreferNsis` is still `tauri-action@v1`'s current input name (or its equivalent) against the action's README before this step runs for real — action inputs change across major versions, and this is the one that determines whether Windows updates work at all.

Note the absence of `bundle.windows.signCommand` above is deliberate, not an oversight: per the design spec §6, Windows ships unsigned for v1 (SmartScreen warning, "run anyway" works). Nothing needs to be added for that — a fresh `tauri.conf.json` has no `signCommand` by default, unlike the Handy fork's, which had to have one *removed*.

- [ ] **Step 4: Commit and hold for the human prerequisites**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities/default.json .github/workflows/release.yml
git commit -m "feat: wire the release pipeline — signed builds across five platform legs, published to the public releases repo"
```

Do not run `gh workflow run release.yml` until every Step 1 prerequisite is confirmed done — an incomplete run against a real (if draft) GitHub Release is not free to unwind cleanly.

---

### Task 16: Auto-updater frontend wiring

**Files:**
- Create: `shorthand-config/src/components/update-checker/UpdateChecker.tsx`
- Modify: `shorthand-config/src/App.tsx`
- Modify: `shorthand-config/package.json` — add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`

**Interfaces:**
- Consumes: nothing project-specific — this is the same `check` → `downloadAndInstall` → `relaunch` shape the Handy fork already has working in `src/components/update-checker/UpdateChecker.tsx`.

- [ ] **Step 1: Add the plugin packages and Rust-side registration**

```bash
bun add @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

`src-tauri/Cargo.toml`: add `tauri-plugin-updater = "2.10.0"`, `tauri-plugin-process = "2"`. `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`, `.plugin(tauri_plugin_process::init())`.

- [ ] **Step 2: Write the component**

```tsx
import { useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export function UpdateChecker() {
  const [status, setStatus] = useState<"idle" | "checking" | "available" | "installing" | "none" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function checkForUpdate() {
    setStatus("checking");
    setError(null);
    try {
      const update = await check();
      if (update === null) {
        setStatus("none");
        return;
      }
      setStatus("available");
      await update.downloadAndInstall();
      setStatus("installing");
      await relaunch();
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  return (
    <div>
      <button onClick={checkForUpdate} disabled={status === "checking" || status === "installing"}>
        Check for updates
      </button>
      {status === "none" && <p>You're on the latest version.</p>}
      {status === "error" && error !== null && <p role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Mount it and verify the build**

Add `<UpdateChecker />` to `App.tsx` alongside `<ConnectGoogle />`.

Run: `bun run build && cd src-tauri && cargo build`
Expected: PASS. A real update check against a live endpoint isn't testable until Task 15's release pipeline has published at least one real release — that's Task 17.

- [ ] **Step 4: Commit**

```bash
git add src/components/update-checker/UpdateChecker.tsx src/App.tsx package.json bun.lock src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat: wire the updater UI (check -> downloadAndInstall -> relaunch)"
```

---

### Task 17: Whole-branch verification and release rehearsal

**This task is where the plan's automatable parts get one final green run, and where the parts that need a human (a real Google account, a real Apple/Azure credential, a real published release) get explicitly handed off rather than silently assumed.**

**Files:** none created; this task runs checks and records results.

- [ ] **Step 1: Full automated suite, one more time, from clean**

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd .. && bun run lint && bun run build
```

Expected: all green.

- [ ] **Step 2: Confirm no forbidden strings leaked in from the Handy fork**

```bash
grep -rniE "handy|cjpais|CJ-Signing" src-tauri/tauri.conf.json src-tauri/capabilities/ .github/workflows/
```

Expected: no output. (This app was scaffolded fresh in Task 1, not copied from Handy, so this should already be clean — this step is the check that proves it, per the design spec's own verification list.)

- [ ] **Step 3: Confirm the scope guard and conformance suite both still pass, and re-run their mutation checks**

Re-run Task 13 Step 3's mutation check and Task 14 Step 4's mutation check once more against the final state of the tree, since intervening tasks (12, 15, 16) touched files neither guard directly tests but that could theoretically have reintroduced a scope or a merge.

- [ ] **Step 4: Hand off the parts that need a human, explicitly**

The following cannot be completed by an agent and should be handed to the human directly, one at a time, not assumed done:

1. **Register the real Google Cloud OAuth client** (Task 10's prerequisite) and confirm the consent screen is configured for `drive.file` only.
2. **Run the full six-step consent flow against a real Google account**, both the picker path and the create path, and specifically **run the picker flow first, then the create flow on the same account**, confirming the pre-existing document moves into the newly created folder — this is the reparent rule from Task 8, and it's the one case a natural implementation gets wrong.
3. **Force a failure after folder creation** (e.g. temporarily break the Docs API call) and confirm the error names the orphaned folder's id.
4. **Consent twice with the same already-connected account** and confirm the second consent still yields a refresh token — the only way to observe `prompt=consent` actually doing its job.
5. **Complete Task 15's release prerequisites** (minisign keypair, Apple certificate, releases repo, PAT), run `gh workflow run release.yml`, and confirm all five platform artifacts build and upload.
6. **Install version 0.1.0, then publish 0.1.1, and confirm the installed app detects, downloads, and applies the update** — on Windows and macOS at minimum, Linux if that leg published successfully. This is the only meaningful test of an updater; a green CI build proves nothing about it.
7. **Confirm `latest.json` points at the `.exe` on Windows and the `.app.tar.gz` on macOS**, not the `.msi`/`.dmg`.

- [ ] **Step 5: Final commit and PR for whole-branch review**

If this plan was executed on a feature branch rather than directly on `main`, open a PR now and request the whole-branch review called for in the plan header, covering everything in Tasks 1–16 as one unit before merge.
