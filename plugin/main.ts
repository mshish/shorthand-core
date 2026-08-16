import {
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type App,
  type TFile,
} from "obsidian";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
// Core is consumed by package name through its `exports` map — never a deep path.
// That is what keeps core extractable to its own repo as a move plus a dependency line.
import {
  ClaudeAgentClient,
  DEFAULT_CONFIG,
  detectClaudeExecutable,
  detectHandyExecutable,
  EnhanceRunner,
  SidecarWriter,
  StreamClient,
  TranscriptStore,
  enhancementDelta,
  type EnhanceStatus,
  type ExitDiagnosis,
  type PassOutcome,
} from "obsidian-handy-notes";
import {
  MarkdownNoteSink,
  ensureNoteScaffold,
  linkTranscriptFrontmatter,
  locateAiBlock,
  transcriptWikilink,
} from "obsidian-handy-notes/markdown";
import {
  DEFAULT_PLUGIN_SETTINGS,
  INITIAL_PLUGIN_STATE,
  normalizePluginSettings,
  reducePluginState,
  type HandyNotesPluginSettings,
  type PluginUiEvent,
  type PluginUiState,
} from "obsidian-handy-notes/plugin-ui";

type CaptureRuntime = {
  notePath: string;
  sidecarPath: string;
  client: StreamClient;
  sidecar: SidecarWriter;
  enhancer: EnhanceRunner | undefined;
  settled: Promise<ExitDiagnosis>;
  stopping: boolean;
};

export default class HandyNotesPlugin extends Plugin {
  settings: HandyNotesPluginSettings = DEFAULT_PLUGIN_SETTINGS;
  #state: PluginUiState = INITIAL_PLUGIN_STATE;
  // Declared `| undefined` rather than optional: `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property, and both are cleared on teardown.
  #statusBar: HTMLElement | undefined = undefined;
  #capture: CaptureRuntime | undefined = undefined;

  async onload(): Promise<void> {
    this.settings = normalizePluginSettings(await this.loadData());
    this.#statusBar = this.addStatusBarItem();
    this.#renderStatus();
    this.addSettingTab(new HandyNotesSettingTab(this.app, this));

    // Command names carry no plugin prefix and are sentence case, per Obsidian's plugin
    // guidelines: the command palette already renders these as "Handy Notes: Start capture
    // on this note". Spelling it out here produced "Handy Notes: Handy: start capture…".
    this.addCommand({
      id: "start-capture-this-note",
      name: "Start capture on this note",
      callback: () => { void this.startCaptureOnActiveNote(); },
    });
    this.addCommand({
      id: "stop-capture",
      name: "Stop capture",
      callback: () => { void this.stopCapture(false); },
    });
    this.addCommand({
      id: "enhance-now",
      name: "Enhance now",
      callback: () => { void this.enhanceActiveNote(); },
    });

    // StreamClient owns the child process. These hooks synchronously signal it
    // before Obsidian tears down the plugin or application.
    this.registerDomEvent(window, "beforeunload", () => this.forceStopCapture());
    this.registerEvent(this.app.workspace.on("quit", () => this.forceStopCapture()));
  }

  onunload(): void {
    this.forceStopCapture();
  }

  async saveSettings(candidate: unknown): Promise<void> {
    this.settings = normalizePluginSettings(candidate);
    await this.saveData(this.settings);
  }

  async startCaptureOnActiveNote(): Promise<void> {
    if (this.#capture !== undefined) {
      new Notice("Handy Notes is already capturing. Stop it before starting another note.");
      return;
    }
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const notePath = resolve(vaultRoot, file.path);

    try {
      if (!await this.ensureScaffold(notePath)) return;
      const noteContent = await readFile(notePath, "utf8");
      const linked = transcriptWikilink(noteContent);
      const relativeSidecar = linked === undefined
        ? `${this.settings.sidecarDirectory}/${timestampName(new Date())}`
        : addMarkdownExtension(linked);
      const sidecarPath = resolve(vaultRoot, relativeSidecar);
      if (!isInside(vaultRoot, sidecarPath) || samePath(notePath, sidecarPath)) {
        this.fail("The configured transcript sidecar path is outside the vault or resolves to the meeting note.");
        return;
      }
      if (linked === undefined) {
        const link = relative(vaultRoot, sidecarPath).replaceAll("\\", "/").replace(/\.md$/i, "");
        const result = await linkTranscriptFrontmatter(notePath, link);
        if (result.status === "note-locked") {
          this.fail("The meeting note remained locked while adding its transcript link. Close competing file handles and retry.");
          return;
        }
        if (result.status === "retry") {
          this.fail("The meeting note kept changing while adding its transcript link. Let Obsidian finish saving and retry.");
          return;
        }
        if (result.status === "error") {
          this.fail(result.error.message);
          return;
        }
      }

      const transcript = new TranscriptStore();
      const sidecar = new SidecarWriter(sidecarPath, { flushIntervalMs: DEFAULT_CONFIG.sidecarFlushIntervalMs });
      let enhancer: EnhanceRunner | undefined;
      let enhancementUnavailable: string | undefined;
      try {
        enhancer = this.createEnhancer(notePath, vaultRoot);
      } catch (error) {
        enhancementUnavailable = `${errorMessage(error)} Capture will continue with transcript only.`;
      }
      const client = new StreamClient({
        // Blank setting means "find it for me"; an explicit path always wins.
        command: detectHandyExecutable(this.settings.handyExecutable || undefined),
        args: DEFAULT_CONFIG.followStreamArgs,
        maxReconnectAttempts: DEFAULT_CONFIG.reconnect.maxAttempts,
        backoffMs: DEFAULT_CONFIG.reconnect.backoffMs,
        drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
      });
      const settled = new Promise<ExitDiagnosis>((resolveSettled) => client.once("settled", resolveSettled));
      const runtime: CaptureRuntime = { notePath, sidecarPath, client, sidecar, enhancer, settled, stopping: false };
      this.#capture = runtime;
      this.dispatch({ type: "capture-started" });
      if (enhancementUnavailable !== undefined) this.fail(enhancementUnavailable);

      client.on("event", ({ generation, record }) => {
        const update = transcript.ingest(generation, record);
        if (update === null) return;
        sidecar.apply(update);
        const delta = enhancementDelta(update);
        if (delta.length === 0) return;
        enhancer?.appendTranscript(delta);
        if (enhancer !== undefined && this.settings.enableLiveEnhancement) {
          enhancer.requestTick();
          console.log(
            `[handy-notes] transcript +${delta.length} chars; pending ${enhancer.state.pendingCharacters}/${this.settings.minNewChars} toward next pass`,
          );
        }
        this.#renderStatus();
      });
      client.on("disconnect", ({ generation }) => {
        for (const update of transcript.markConnectionEnded(generation)) sidecar.apply(update);
      });
      client.on("reconnect", ({ generation, gap }) => {
        if (gap) sidecar.addReconnectWarning(generation);
      });
      client.on("connectionError", ({ record }) => this.fail(`Handy connection error (${record.code}): ${record.message}`));
      client.on("protocolError", ({ error }) => this.fail(error.message));
      client.on("processError", ({ error, command }) => this.fail(
        `Could not start "${command}". Check the handy.exe path in Handy Notes settings. ${error.message}`,
      ));
      client.on("giveUp", ({ attempts }) => this.fail(`Handy stream disconnected repeatedly; gave up after ${attempts} reconnect attempts.`));
      client.on("drainTimeout", () => this.fail("Handy did not finish the active transcript before the drain timeout; the child was stopped."));
      sidecar.on("writeError", ({ error }) => this.fail(`Transcript sidecar write failed: ${error.message}`));
      void settled.then((diagnosis) => this.captureSettled(runtime, diagnosis));
      client.start();
      new Notice(`Handy Notes capture started: ${file.path}`);
    } catch (error) {
      this.fail(errorMessage(error));
      this.forceStopCapture();
    }
  }

  async stopCapture(force: boolean): Promise<void> {
    const runtime = this.#capture;
    if (runtime === undefined) {
      new Notice("Handy Notes is not capturing.");
      return;
    }
    runtime.stopping = true;
    runtime.enhancer?.stopLiveTicks();
    if (force) runtime.client.forceStop();
    else runtime.client.stopAfterDrain();
    await runtime.settled;
    await this.finishRuntime(runtime, !force);
  }

  forceStopCapture(): void {
    const runtime = this.#capture;
    if (runtime === undefined) return;
    runtime.stopping = true;
    runtime.enhancer?.stopLiveTicks();
    runtime.client.forceStop();
    // Obsidian does not await onunload/beforeunload. Signal first so the child
    // cannot be orphaned, then best-effort flush pending sidecar bytes.
    void runtime.sidecar.close().catch(() => {});
    this.#capture = undefined;
    this.dispatch({ type: "capture-stopped" });
  }

  async enhanceActiveNote(): Promise<void> {
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const notePath = resolve(vaultRoot, file.path);
    try {
      if (!await this.ensureScaffold(notePath)) return;
      if (this.#capture?.notePath === notePath && this.#capture.enhancer !== undefined) {
        const outcome = await this.#capture.enhancer.enhanceNow("link");
        this.reportOutcome(outcome);
        return;
      }
      const content = await readFile(notePath, "utf8");
      const linked = transcriptWikilink(content);
      if (linked === undefined) {
        this.fail("This note has no handy-transcript wikilink. Start capture once to create and link a sidecar.");
        return;
      }
      const sidecarPath = resolve(vaultRoot, addMarkdownExtension(linked));
      if (!isInside(vaultRoot, sidecarPath)) {
        this.fail("The note's handy-transcript link resolves outside the vault.");
        return;
      }
      const enhancer = this.createEnhancer(notePath, vaultRoot);
      enhancer.appendTranscript(await readFile(sidecarPath, "utf8"));
      const outcome = await enhancer.enhanceNow("link");
      this.reportOutcome(outcome);
    } catch (error) {
      this.fail(`Enhancement failed: ${errorMessage(error)}`);
    }
  }

  private createEnhancer(notePath: string, vaultRoot: string): EnhanceRunner {
    const configuredClaude = this.settings.claudeExecutable;
    if (configuredClaude.length > 0 && !existsSync(configuredClaude)) {
      throw new Error(`claude.exe was not found at "${configuredClaude}". Update the path in Handy Notes settings.`);
    }
    const claudeExecutable = detectClaudeExecutable(configuredClaude.length === 0 ? undefined : configuredClaude);
    if (claudeExecutable === undefined && process.platform === "win32") {
      throw new Error("claude.exe was not found. Install and log in to Claude CLI, or configure its full path in Handy Notes settings.");
    }
    return new EnhanceRunner({
      sink: new MarkdownNoteSink({ notePath, vaultRoot }),
      agent: new ClaudeAgentClient(),
      minNewChars: this.settings.minNewChars,
      minIntervalMs: this.settings.minIntervalMs,
      maxPasses: this.settings.maxPasses,
      maxUsd: this.settings.maxUsd,
      maxPassUsd: DEFAULT_CONFIG.enhancement.maxPassUsd,
      timeoutMs: DEFAULT_CONFIG.enhancement.timeoutMs,
      maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
      ...(claudeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: claudeExecutable }),
      onStatus: (status) => this.onEnhanceStatus(status),
    });
  }

  private async ensureScaffold(notePath: string): Promise<boolean> {
    const located = locateAiBlock(await readFile(notePath, "utf8"));
    if (located.ok) return true;
    if (located.error.code !== "markers-missing") {
      this.fail(located.error.message);
      return false;
    }
    if (!await confirmScaffold(this.app)) return false;
    const result = await ensureNoteScaffold(notePath, DEFAULT_CONFIG.templateSections);
    if (result.status === "written" || result.status === "unchanged") return true;
    if (result.status === "note-locked") {
      this.fail("The meeting note remained locked while adding Handy markers. Let Obsidian finish saving and retry.");
    } else if (result.status === "retry") {
      this.fail("The meeting note changed repeatedly while adding Handy markers. Retry after it settles.");
    } else {
      this.fail(result.error.message);
    }
    return false;
  }

  private async finishRuntime(runtime: CaptureRuntime, finalEnhancement: boolean): Promise<void> {
    if (this.#capture !== runtime) return;
    try {
      await runtime.sidecar.close();
      await runtime.enhancer?.waitForIdle();
      if (finalEnhancement && runtime.enhancer !== undefined) {
        this.reportOutcome(await runtime.enhancer.enhanceNow("link"));
      }
      new Notice("Handy Notes capture stopped.");
    } catch (error) {
      this.fail(`Capture shutdown failed: ${errorMessage(error)}`);
    } finally {
      if (this.#capture === runtime) this.#capture = undefined;
      this.dispatch({ type: "capture-stopped" });
    }
  }

  private async captureSettled(runtime: CaptureRuntime, diagnosis: ExitDiagnosis): Promise<void> {
    if (runtime.stopping || this.#capture !== runtime) return;
    runtime.stopping = true;
    if (!diagnosis.clean) this.fail(streamExitMessage(diagnosis));
    await this.finishRuntime(runtime, false);
  }

  private onEnhanceStatus(status: EnhanceStatus): void {
    if (status.kind === "started") {
      this.dispatch({ type: "enhancement-started", passCount: status.passCount });
    } else if (status.kind === "finished") {
      this.dispatch({ type: "enhancement-finished", passCount: status.passCount });
    } else if (status.kind === "budget-exhausted") {
      this.dispatch({ type: "budget-exhausted", passCount: status.passCount, message: status.message });
      new Notice(status.message, 8_000);
    } else if (status.kind === "error") {
      this.fail(status.message, status.passCount);
    } else if (status.kind === "requeued" && status.retryAfterMs !== undefined) {
      // Only a target that asked for a backoff is actionable. A plain re-queue means
      // the note kept changing under the writer — i.e. the user is typing during the
      // meeting — which self-heals on the next pass and must stay silent.
      this.fail(`${status.message} Close competing file handles; Handy Notes will retry on the next pass.`, status.passCount);
    }
  }

  private reportOutcome(outcome: PassOutcome): void {
    if (outcome.status === "completed") {
      this.dispatch({ type: "enhancement-finished", passCount: this.#state.passCount });
      new Notice(outcome.written ? "Handy Notes updated the AI block." : "The AI block was already up to date.");
    } else if (outcome.status === "budget-exhausted") {
      const message = `Enhancement ${outcome.reason} budget is exhausted; capture continues.`;
      this.dispatch({ type: "budget-exhausted", passCount: this.#state.passCount, message });
      new Notice(message, 8_000);
    } else if (outcome.status === "requeued") {
      this.fail(outcome.retryAfterMs === undefined
        ? `Enhancement was safely re-queued (${outcome.reason}).`
        : "The meeting note was busy. Close competing file handles and run Enhance now again.");
    } else if (outcome.status === "failed") {
      this.fail(outcome.error);
    } else if (outcome.status !== "not-ready" && outcome.status !== "in-flight") {
      this.fail(`Enhancement did not complete (${outcome.status}).`);
    }
  }

  private activeMarkdownFile(): TFile | undefined {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (file !== null && file !== undefined) return file;
    new Notice("Open a Markdown note before running Handy Notes.");
    return undefined;
  }

  private vaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    this.fail("Handy Notes requires a desktop filesystem-backed Obsidian vault.");
    return undefined;
  }

  private fail(message: string, passCount?: number): void {
    this.dispatch({ type: "error", message, ...(passCount === undefined ? {} : { passCount }) });
    new Notice(`Handy Notes: ${message}`, 10_000);
    console.error(`[handy-notes] ${message}`);
  }

  private dispatch(event: PluginUiEvent): void {
    this.#state = reducePluginState(this.#state, event);
    this.#renderStatus();
  }

  #renderStatus(): void {
    if (this.#statusBar === undefined) return;
    const passes = `${this.#state.passCount} ${this.#state.passCount === 1 ? "pass" : "passes"}`;
    // Show progress toward the next tick. Without this the plugin looks broken while it is
    // simply below the character gate — the exact confusion this feature was added to fix.
    const pending = this.#capture?.enhancer?.state.pendingCharacters;
    const progress = pending === undefined
      ? ""
      : ` · ${pending}/${this.settings.minNewChars} chars`;
    this.#statusBar.setText(`Handy: ${this.#state.mode}${progress} · ${passes}`);
    this.#statusBar.setAttribute(
      "title",
      this.#state.message ?? (pending === undefined
        ? "Handy Notes status"
        : `${pending} of ${this.settings.minNewChars} characters toward the next enhancement pass. "Handy Notes: Enhance now" runs one immediately.`),
    );
  }
}

class HandyNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HandyNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // No plugin-name heading at the top: Obsidian already titles this pane "Handy Notes", and
    // the guidelines reserve headings for separating multiple sections.
    textSetting(containerEl, this.plugin, "Handy executable", "Path to handy.exe, or a command available on PATH.", "handyExecutable");
    textSetting(containerEl, this.plugin, "Claude executable", "Optional path to claude.exe. Leave blank for automatic detection.", "claudeExecutable");
    textSetting(containerEl, this.plugin, "Transcript sidecar directory", "Vault-relative directory used for new transcript notes.", "sidecarDirectory");
    numberSetting(containerEl, this.plugin, "Minimum new characters", "Live-pass transcript threshold.", "minNewChars");
    numberSetting(containerEl, this.plugin, "Minimum interval (ms)", "Minimum time between completed live passes.", "minIntervalMs");
    numberSetting(containerEl, this.plugin, "Maximum passes", "Hard model-attempt cap per capture.", "maxPasses");
    numberSetting(containerEl, this.plugin, "Maximum USD", "Reported-cost cap per capture; see the limitation below.", "maxUsd");
    new Setting(containerEl)
      .setName("Enable live enhancement")
      .setDesc("Run tick passes while capture is active. Stop and Enhance now still use a link-tier pass.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enableLiveEnhancement)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, enableLiveEnhancement: value })));

    // setHeading() rather than a raw <h3>: the guidelines call for it, and it inherits
    // Obsidian's own settings typography instead of hardcoding a heading level.
    new Setting(containerEl)
      .setName("Direct-file write limitation")
      .setHeading()
      .setDesc(
        "Handy Notes writes through its core atomic file writer, not Obsidian's vault API. Obsidian detects those writes with its file watcher. If a note has unsaved keystrokes in an editor buffer, that buffer can win on its next save and an AI update may be lost. This is the safe direction: user text is never discarded by Handy Notes.",
      );
  }
}

function textSetting(
  container: HTMLElement,
  plugin: HandyNotesPlugin,
  name: string,
  description: string,
  key: "handyExecutable" | "claudeExecutable" | "sidecarDirectory",
): void {
  new Setting(container).setName(name).setDesc(description).addText((text) => text
    .setValue(plugin.settings[key])
    .onChange(async (value) => plugin.saveSettings({ ...plugin.settings, [key]: value })));
}

function numberSetting(
  container: HTMLElement,
  plugin: HandyNotesPlugin,
  name: string,
  description: string,
  key: "minNewChars" | "minIntervalMs" | "maxPasses" | "maxUsd",
): void {
  new Setting(container).setName(name).setDesc(description).addText((text) => {
    text.inputEl.type = "number";
    text.setValue(String(plugin.settings[key])).onChange(async (value) => {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) await plugin.saveSettings({ ...plugin.settings, [key]: parsed });
    });
  });
}

class ScaffoldModal extends Modal {
  #settled = false;

  constructor(app: App, private readonly resolveChoice: (choice: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Add Handy Notes markers?");
    this.contentEl.createEl("p", {
      text: "This note has no Handy AI ownership block. Add the user-notes marker and seeded AI section scaffold without changing existing note text?",
    });
    const buttons = this.contentEl.createDiv();
    const add = buttons.createEl("button", { text: "Add scaffold" });
    add.addClass("mod-cta");
    add.onclick = () => { this.choose(true); this.close(); };
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.choose(false); this.close(); };
  }

  onClose(): void {
    this.choose(false);
    this.contentEl.empty();
  }

  private choose(choice: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.resolveChoice(choice);
  }
}

function confirmScaffold(app: App): Promise<boolean> {
  return new Promise((resolveChoice) => new ScaffoldModal(app, resolveChoice).open());
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

function addMarkdownExtension(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function streamExitMessage(diagnosis: ExitDiagnosis): string {
  if (diagnosis.code === 2) {
    return "Handy is not running, or Follow Live Transcript Output is disabled in Handy's Advanced settings.";
  }
  return diagnosis.message || `Handy follow-stream exited with code ${String(diagnosis.code)}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
