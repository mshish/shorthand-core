from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from collections.abc import Iterable
from pathlib import Path
from typing import Any, TypeVar

import pytest
from deepeval import assert_test
from deepeval.metrics import GEval
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase, SingleTurnParams
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parents[1]
BUN = os.environ.get("SHORTHAND_EVAL_BUN", "bun")
CANDIDATE_BACKEND = os.environ.get("SHORTHAND_EVAL_CANDIDATE_BACKEND", "claude")
JUDGE_BACKEND = os.environ.get("SHORTHAND_EVAL_JUDGE_BACKEND", "codex")
T = TypeVar("T", bound=BaseModel)


class LocalAgentModel(DeepEvalBaseLLM):
    """DeepEval adapter backed by the repo's authenticated Claude/Codex SDK clients."""

    def __init__(self, backend: str) -> None:
        if backend not in {"claude", "codex"}:
            raise ValueError(f"unsupported local agent backend: {backend}")
        self.backend = backend

    def load_model(self) -> "LocalAgentModel":
        return self

    def generate(self, prompt: str, schema: type[T] | None = None) -> str | T:
        if schema is None:
            output_schema: dict[str, Any] = {
                "type": "object",
                "properties": {"response": {"type": "string"}},
                "required": ["response"],
                "additionalProperties": False,
            }
        else:
            output_schema = schema.model_json_schema()
        payload = invoke_agent(
            backend=self.backend,
            prompt=prompt,
            system_prompt=(
                "You are an impartial evaluation judge. Follow the requested rubric exactly, "
                "return only the structured result, and do not use tools or outside information."
            ),
            output_schema=output_schema,
        )
        if schema is None:
            response = payload.get("response")
            if not isinstance(response, str):
                raise TypeError("local judge response did not contain a string response")
            return response
        return schema.model_validate(payload)

    async def a_generate(self, prompt: str, schema: type[T] | None = None) -> str | T:
        return await asyncio.to_thread(self.generate, prompt, schema)

    def get_model_name(self) -> str:
        return f"local-{self.backend}-agent"


def invoke_agent(
    *, backend: str, prompt: str, system_prompt: str, output_schema: dict[str, Any]
) -> dict[str, Any]:
    completed = subprocess.run(
        [BUN, "evals/agent-bridge.ts"],
        cwd=ROOT,
        input=json.dumps({
            "backend": backend,
            "prompt": prompt,
            "systemPrompt": system_prompt,
            "outputSchema": output_schema,
        }),
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise TypeError("local agent bridge returned a non-object JSON value")
    return payload


def load_cases() -> list[dict[str, Any]]:
    completed = subprocess.run(
        [BUN, "evals/export-cases.ts"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


CASES = load_cases()


def generate_note(test_case: dict[str, Any]) -> str:
    payload = invoke_agent(
        backend=CANDIDATE_BACKEND,
        prompt=test_case["prompt"],
        system_prompt=test_case["systemPrompt"],
        output_schema=test_case["outputSchema"],
    )
    return "\n\n".join(
        f"## {section['heading']}\n\n{section['markdown']}" for section in payload["sections"]
    )


def normalized_words(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", value.lower())


def phrases(words: list[str], width: int) -> Iterable[tuple[str, ...]]:
    return (tuple(words[index:index + width]) for index in range(len(words) - width + 1))


def assert_no_long_transcript_copy(transcript: str, note: str, width: int = 10) -> None:
    transcript_phrases = set(phrases(normalized_words(transcript), width))
    copied = transcript_phrases.intersection(phrases(normalized_words(note), width))
    assert not copied, f"note copied a {width}-word transcript phrase: {' '.join(next(iter(copied)))}"


def quality_metrics(judge: LocalAgentModel) -> list[GEval]:
    parameters = [
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT,
        SingleTurnParams.EXPECTED_OUTPUT,
    ]
    return [
        GEval(
            name="Faithfulness and coverage",
            evaluation_steps=[
                "Compare each factual claim in the note with the supplied note-taking input.",
                "Check that every material fact named in the expected-output rubric is covered.",
                "Check that uncertainty, attribution, decisions, commitments, owners, and deadlines retain their source meaning.",
                "Penalize unsupported people, facts, decisions, owners, deadlines, or falsely completed table values.",
            ],
            evaluation_params=parameters,
            threshold=0.8,
            model=judge,
        ),
        GEval(
            name="Note quality",
            evaluation_steps=[
                "Assess whether the note is concise, warm, easy to scan, intelligently synthesized, and appropriate to its mode.",
                "Check that it favors structured presentation over paragraphs and uses *-marked outlines, tasks, tables, emphasis, and semantic callouts purposefully.",
                "Reward useful tables even when honest Unknown, Not discussed, or supported TBD cells are necessary.",
                "Penalize transcript quotations, close copying, decorative formatting, dash-marked unordered lists, and invented table values.",
            ],
            evaluation_params=parameters,
            threshold=0.8,
            model=judge,
        ),
    ]


@pytest.mark.parametrize("test_case", CASES, ids=lambda case: case["id"])
def test_default_note_prompt(test_case: dict[str, Any]) -> None:
    note = generate_note(test_case)
    assert_no_long_transcript_copy(test_case["transcript"], note)
    assert not re.search(r"^\s*-\s+", note, re.MULTILINE), "unordered lists must use * markers"
    if test_case["requiresTable"]:
        assert re.search(r"^\|.+\|\s*$", note, re.MULTILINE), "expected a useful Markdown table"
    if test_case["requiresCallout"]:
        assert re.search(r"^> \[!(?:summary|info|tip|success|warning|question)\]", note, re.MULTILINE), (
            "expected a semantic Obsidian callout"
        )
    assert_test(
        LLMTestCase(
            input=test_case["prompt"],
            actual_output=note,
            expected_output=test_case["expectedOutput"],
        ),
        quality_metrics(LocalAgentModel(JUDGE_BACKEND)),
    )
