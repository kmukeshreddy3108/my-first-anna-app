"""End-to-end stdio checks with a deterministic fake sampling host."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / "executas" / "my-first-anna-app"
PLUGIN = PLUGIN_DIR / "my_first_anna_app_plugin.py"
SAMPLES = sorted(ROOT.joinpath("samples").glob("*.md"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def fake_response(prompt: str) -> str:
    point = "The source contains a verified study point."
    source = {"chunkId": "chunk-1", "snippet": point}
    if "Analyze this document" in prompt or "Extract factual" in prompt:
        return json.dumps({
            "documentType": "article",
            "title": "Deterministic sample analysis",
            "keyPoints": [{"text": point, "source": source}],
            "entities": [{"name": "StudyLens", "type": "topic"}],
            "definitions": [{"term": "verified", "meaning": "supported by the source"}],
            "openQuestions": [],
            "chunks": [{"id": "chunk-1", "snippet": point}],
            "sourceLength": len(prompt),
        })
    if "flashcards" in prompt:
        return json.dumps({"cards": [{"question": "What is the verified point?", "answer": point, "concept": "source", "source": source}], "aiGenerated": True})
    if "quiz" in prompt.lower():
        return json.dumps({"questions": [{
            "id": "1", "type": "multiple-choice", "question": "Which statement is supported?",
            "options": [point, "Unsupported distractor A", "Unsupported distractor B", "Unsupported distractor C"],
            "correctAnswer": point, "explanation": "The answer is in the source.", "source": source, "concept": "source",
        }], "coverage": {"coveredConcepts": ["source"], "requestedConcepts": ["source"], "label": "1/1 concepts covered"}, "aiGenerated": True})
    if "action" in prompt.lower() or "study plan" in prompt.lower():
        return json.dumps({"items": [{"task": "Review the verified study point.", "priority": "High", "source": source}], "studyPlan": [{"topic": "source", "estimatedMinutes": 15, "source": source}], "aiGenerated": True})
    if "verify" in prompt.lower() or "critique" in prompt.lower():
        return json.dumps({"grounded": True, "confidence": "high", "revised": json.loads(prompt.split("\n", 1)[-1]) if False else {"text": point}, "changes": [], "unsupported": []})
    if "detailed" in prompt.lower() and "summary" in prompt.lower():
        return json.dumps({
            "mode": "detailed", "summary": point, "overview": point,
            "sections": [{"heading": "Key points", "paragraphs": [point], "whyItMatters": point, "keyTerms": [], "numbers": [], "source": source}],
            "items": [{"text": point, "source": source}], "aiGenerated": True
        })
    if "bullets" in prompt.lower() and "summary" in prompt.lower():
        return json.dumps({
            "mode": "bullets", "summary": point,
            "groups": [{"heading": "Key points", "bullets": [{"text": point, "source": source}]}],
            "items": [{"text": point, "source": source}], "aiGenerated": True
        })
    if "simple" in prompt.lower() and "summary" in prompt.lower():
        return json.dumps({
            "mode": "simple", "summary": point, "intro": point,
            "items": [{"text": point, "explanation": point, "analogy": point, "source": source}],
            "aiGenerated": True
        })
    if "exam_notes" in prompt.lower() and "summary" in prompt.lower():
        return json.dumps({
            "mode": "exam_notes", "summary": point, "definitions": [], "facts": [{"text": point, "source": source}],
            "processes": [], "comparisons": [], "mistakes": [], "questions": [{"text": point, "source": source}],
            "items": [{"text": point, "source": source}], "aiGenerated": True
        })
    return json.dumps({"mode": "short", "summary": point, "items": [{"text": point, "source": source}], "aiGenerated": True})


class FakeHost:
    def __init__(self, mode: str = "normal") -> None:
        self.mode = mode
        env = os.environ.copy()
        env["PYTHONUTF8"] = "0"
        env["PYTHONIOENCODING"] = "utf-8"
        env["ANNA_ANALYST_STORE"] = str(ROOT / ".selftest-analyses.json")
        self.process = subprocess.Popen(
            [sys.executable, str(PLUGIN)],
            cwd=PLUGIN_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            bufsize=1,
        )
        self.next_id = 1

    def send(self, method: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        request = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if method == "invoke" and arguments is not None:
            request["params"] = arguments
        elif arguments is not None:
            request["params"] = {"tool": method, "arguments": arguments}
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(request, ensure_ascii=True) + "\n")
        self.process.stdin.flush()
        return self._read_until(request_id)

    def _read_until(self, request_id: int) -> dict[str, Any]:
        assert self.process.stdout is not None
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError(f"plugin exited with code {self.process.poll()}")
            message = json.loads(line)
            if message.get("method") == "sampling/createMessage":
                if self.mode == "never":
                    continue
                if self.mode == "slow":
                    time.sleep(20)
                if self.mode == "error":
                    response = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32001, "message": "fake model unavailable"}}
                elif self.mode == "malformed":
                    response = {"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": "{bad json"}]}}
                else:
                    response = {"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": fake_response(message["params"]["messages"][0]["content"]["text"])}]}}
                assert self.process.stdin is not None
                self.process.stdin.write(json.dumps(response) + "\n")
                self.process.stdin.flush()
            elif message.get("id") == request_id:
                return message

    def close(self) -> str:
        if self.process.stdin:
            self.process.stdin.close()
        stderr = self.process.stderr.read() if self.process.stderr else ""
        self.process.wait(timeout=5)
        return stderr


def call(host: FakeHost, method: str, args: dict[str, Any]) -> dict[str, Any]:
    response = host.send("invoke", {"tool": method, "arguments": args})
    if "error" in response:
        raise AssertionError(response)
    result = response["result"]
    if result.get("success") is False:
        raise AssertionError(result)
    return result["data"]


def check_sample(host: FakeHost, path: Path) -> list[tuple[str, str, float]]:
    text = path.read_text(encoding="utf-8")
    rows = []
    def checked(name: str, action) -> Any:
        started = time.perf_counter()
        value = action()
        rows.append((f"{path.stem} × {name}", "PASS", time.perf_counter() - started))
        return value

    analysis_data = checked("analyze_document", lambda: call(host, "analyze_document", {"text": text}))
    analysis = analysis_data["analysis"]
    cursor = analysis_data.get("nextCursor")
    while cursor is not None:
        page = checked("analyze_document(cursor)", lambda: call(host, "analyze_document", {"text": text, "cursor": cursor, "max_chunks": 3}))
        analysis["keyPoints"].extend(page["analysis"].get("keyPoints", []))
        cursor = page.get("nextCursor")
    summary_fields = {
        "short": "summary",
        "detailed": "overview",
        "bullets": "groups",
        "simple": "intro",
        "exam_notes": "facts",
    }
    for mode, field in summary_fields.items():
        output = checked(f"generate_summary[{mode}]", lambda mode=mode: call(host, "generate_summary", {"analysis": analysis, "mode": mode})["output"])
        value = output.get(field)
        assert value
        assert output.get("summary") and len(output["summary"]) < len(text)
    checked("generate_action_items", lambda: call(host, "generate_action_items", {"analysis": analysis}))
    cards = checked("generate_flashcards", lambda: call(host, "generate_flashcards", {"analysis": analysis, "count": 1}))["output"]
    assert cards["cards"][0]["source"]["chunkId"]
    quiz = checked("generate_quiz", lambda: call(host, "generate_quiz", {"analysis": analysis, "count": 1})["output"])
    assert len(quiz["questions"][0]["options"]) == 4 and quiz["coverage"]
    checked("grade_quiz", lambda: call(host, "grade_quiz", {"quiz": quiz, "answers": {"1": quiz["questions"][0]["correctAnswer"]}}))
    checked("ask_question", lambda: call(host, "ask_question", {"source_text": text, "analysis": analysis, "question": "What is the main point?"}))
    outside = checked("ask_question[not found]", lambda: call(host, "ask_question", {"source_text": text, "analysis": analysis, "question": "What is the moon made of?"}))
    assert outside["answer"]["grounded"] is False
    checked("verify_and_refine", lambda: call(host, "verify_and_refine", {"source_text": text, "draft": {"text": analysis["keyPoints"][0]["text"]}}))
    saved = checked("save_analysis", lambda: call(host, "save_analysis", {"analysis": analysis, "title": path.stem}))
    record_id = saved["analysis"]["id"]
    checked("list_analyses", lambda: call(host, "list_analyses", {}))
    checked("get_analysis", lambda: call(host, "get_analysis", {"id": record_id}))
    checked("delete_analysis", lambda: call(host, "delete_analysis", {"id": record_id}))
    return rows


def main() -> int:
    all_rows: list[tuple[str, str, float]] = []
    host = FakeHost()
    try:
        assert host.send("health")["result"]["status"] == "ready"
        for sample in SAMPLES:
            if sample.name == "README.md":
                continue
            all_rows.extend(check_sample(host, sample))
    finally:
        stderr = host.close()
    timeout_host = FakeHost("never")
    started = time.perf_counter()
    timeout_result = timeout_host.send("invoke", {"tool": "generate_summary", "arguments": {"analysis": {"keyPoints": [{"text": "A verified point.", "source": {}}]}, "mode": "short"}})
    timeout_duration = time.perf_counter() - started
    assert timeout_host.process.poll() is None
    timeout_stderr = timeout_host.close()
    assert timeout_result["result"]["success"] is True
    assert timeout_result["result"]["data"]["source"] == "rule-based"
    all_rows.append(("timeout isolation", "PASS", timeout_duration))
    malformed = FakeHost("malformed")
    malformed_result = call(malformed, "generate_summary", {"analysis": {"keyPoints": [{"text": "A verified point.", "source": {}}]}, "mode": "short"})
    malformed.close()
    assert malformed_result["source"] == "rule-based"
    all_rows.append(("malformed model fallback", "PASS", 0.0))
    error_host = FakeHost("error")
    error_result = call(error_host, "generate_summary", {"analysis": {"keyPoints": [{"text": "A verified point.", "source": {}}]}, "mode": "short"})
    error_host.close()
    assert error_result["source"] == "rule-based"
    all_rows.append(("model error fallback", "PASS", 0.0))
    slow = FakeHost("slow")
    started = time.perf_counter()
    slow_result = call(slow, "generate_summary", {"analysis": {"keyPoints": [{"text": "A verified point.", "source": {}}]}, "mode": "short"})
    slow_duration = time.perf_counter() - started
    slow.close()
    assert slow_result["source"] == "rule-based"
    all_rows.append(("slow model fallback", "PASS", slow_duration))
    print("sample × tool | result | seconds")
    print("-" * 60)
    for name, result, duration in all_rows:
        print(f"{name} | {result} | {duration:.3f}")
    print(f"TOTAL PASS={len(all_rows)}")
    if stderr or timeout_stderr:
        print("plugin stderr captured: yes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
