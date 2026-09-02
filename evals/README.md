# Local note-prompt evaluations

This optional DeepEval suite generates notes with the exact prompt constants, pass framing,
structured-output schema, and authenticated agent clients used by core. The candidate and judge
both run through the locally installed Claude Code or Codex agent. No provider API key or
DeepEval cloud account is required, and nothing in CI runs the suite.

The suite uses deterministic checks for transcript copying, required Obsidian structures, and
unordered-list markers, plus DeepEval G-Eval scores for faithfulness and note quality. Agent
outputs and judge scores are nondeterministic and consume the selected subscriptions' usage.

## Set up

Sign in with whichever local agents you plan to use, for example `claude login` and/or
`codex login`. The bridge deliberately reuses the repo's official SDK clients rather than
maintaining a second set of shell-output parsers; those clients invoke the installed agents,
reuse their local sign-in, disable tools for these evaluations, and enforce JSON Schema output.

From `shorthand-core`, create an isolated Python environment and install the local-only tools:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r evals\requirements.txt
```

The `.venv`, `.env.local`, Python caches, and local result directory are ignored by Git.

## Run

```powershell
.venv\Scripts\deepeval test run evals\test_note_prompts.py
```

By default, Claude generates the notes and Codex judges them, avoiding candidate self-grading.
Choose either local agent for either role:

```powershell
$env:SHORTHAND_EVAL_CANDIDATE_BACKEND = "codex"
$env:SHORTHAND_EVAL_JUDGE_BACKEND = "claude"
.venv\Scripts\deepeval test run evals\test_note_prompts.py
```

Optional backend-specific settings are:

* `SHORTHAND_EVAL_CLAUDE_MODEL`
* `SHORTHAND_EVAL_CLAUDE_EFFORT`
* `SHORTHAND_EVAL_CLAUDE_EXE`
* `SHORTHAND_EVAL_CODEX_MODEL`
* `SHORTHAND_EVAL_CODEX_EFFORT`
* `SHORTHAND_EVAL_CODEX_EXE`
* `SHORTHAND_EVAL_BUN`

Unset model and effort values inherit the installed agent's defaults. Add reviewed,
representative cases to `cases.json`; `expectedOutput` is a scoring rubric, not prose the note
must copy.

## Call budget

The current suite contains four cases and two G-Eval metrics. Each full run normally uses:

* 4 candidate turns: one note generation per case
* 8 judge turns: two metric scores per case
* 12 local agent turns total

The deterministic transcript-copying and Markdown assertions make no model calls. The G-Eval
steps are written explicitly in the test, so DeepEval does not spend an additional judge turn
inventing evaluation steps for each metric. With the defaults, the 4 candidate turns use Claude
and the 8 judge turns use Codex; changing the backend variables changes that distribution, not
the total.

Treat 12 as the normal minimum rather than a hard ceiling. Structured-output recovery inside an
agent, a failed test rerun, or pytest repeat options can increase underlying model requests. The
budget scales by three local agent turns for each additional case while the suite retains two
single-turn metrics.
