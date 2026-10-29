"""AI Study & Document Analyst Executa.

The process speaks JSON-RPC on stdout. Logs and tracebacks go to stderr.
Sampling is optional: when unavailable, tools return explicit structured
errors rather than pretending that a result was AI-generated.
"""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

MAX_TEXT_CHARS = 120_000
CHUNK_CHARS = 12_000
SAMPLE_TIMEOUT = 45
STORE_PATH = Path(os.environ.get("ANNA_ANALYST_STORE", Path.home() / ".anna-study-analyses.json"))

MANIFEST: dict[str, Any] = {
    "display_name": "tool-dev-my-first-anna-app",
    "version": "0.3.0",
    "description": "AI Study & Document Analyst with structured analysis, verified outputs, and grounded follow-up questions.",
    "host_capabilities": ["llm.sample", "llm.complete"],
    "tools": [
        {"name": "analyze_document", "description": "Classify and structurally analyze a document.", "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
        {"name": "generate_outputs", "description": "Generate a summary, action list, flashcards, or quiz from analysis.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "mode": {"type": "string"}}, "required": ["analysis", "mode"]}},
        {"name": "critique_and_refine", "description": "Check a draft against source text and revise unsupported or missing content.", "parameters": {"type": "object", "properties": {"source_text": {"type": "string"}, "draft": {}}, "required": ["source_text", "draft"]}},
        {"name": "ask_followup", "description": "Answer a question using only the supplied document analysis.", "parameters": {"type": "object", "properties": {"source_text": {"type": "string"}, "analysis": {"type": "object"}, "question": {"type": "string"}, "history": {"type": "array"}}, "required": ["source_text", "analysis", "question"]}},
        {"name": "save_analysis", "description": "Save an analysis for later review.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "title": {"type": "string"}}, "required": ["analysis"]}},
        {"name": "list_analyses", "description": "List saved analyses.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
        {"name": "get_analysis", "description": "Get a saved analysis by ID.", "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
        {"name": "delete_analysis", "description": "Delete a saved analysis by ID.", "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    ],
}

_responses: dict[str, queue.Queue[dict[str, Any]]] = {}
_requests: queue.Queue[dict[str, Any]] = queue.Queue()
_sampling_enabled = True
_store_lock = threading.Lock()


def _write(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _reader() -> None:
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
            if not isinstance(message, dict):
                raise ValueError("JSON-RPC message must be an object")
            request_id = message.get("id")
            if "method" not in message and request_id in _responses:
                _responses[request_id].put(message)
            else:
                _requests.put(message)
        except (json.JSONDecodeError, ValueError) as error:
            _log(f"invalid input: {error}")


def _sample(prompt: str, max_tokens: int = 900) -> tuple[str | None, str | None]:
    global _sampling_enabled
    if not _sampling_enabled:
        return None, "AI sampling is unavailable or denied."
    request_id = str(uuid.uuid4())
    response_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    _responses[request_id] = response_queue
    _write({"jsonrpc": "2.0", "id": request_id, "method": "sampling/createMessage", "params": {
        "messages": [{"role": "user", "content": {"type": "text", "text": prompt}}],
        "maxTokens": max_tokens,
    }})
    try:
        response = response_queue.get(timeout=SAMPLE_TIMEOUT)
        if "error" in response:
            error = response.get("error", {})
            _sampling_enabled = False if error.get("code") in (-32001, -32008) else _sampling_enabled
            return None, str(error.get("message", "AI sampling failed"))
        result = response.get("result", {})
        content = result.get("content", [])
        if isinstance(content, list):
            text = next((block.get("text") for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)), None)
        elif isinstance(content, dict):
            text = content.get("text")
        else:
            text = result.get("text")
        return (text, None) if isinstance(text, str) and text.strip() else (None, "AI sampling returned no text.")
    except queue.Empty:
        return None, "AI sampling timed out."
    finally:
        _responses.pop(request_id, None)


def _clean_json(text: str) -> str:
    return re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text.strip(), flags=re.IGNORECASE)


def _sample_json(prompt: str, fallback: dict[str, Any], max_tokens: int = 1200) -> tuple[dict[str, Any], str, str | None]:
    text, error = _sample(prompt, max_tokens)
    parsed = None
    if text:
        try:
            value = json.loads(_clean_json(text))
            parsed = value if isinstance(value, dict) else None
        except (json.JSONDecodeError, TypeError):
            parsed = None
    if parsed is None and text:
        retry_text, retry_error = _sample(prompt + "\nReturn valid JSON only. No markdown fences, no commentary.", max_tokens)
        error = retry_error or error
        if retry_text:
            try:
                value = json.loads(_clean_json(retry_text))
                parsed = value if isinstance(value, dict) else None
            except (json.JSONDecodeError, TypeError):
                parsed = None
        if parsed is None:
            error = error or "The AI returned malformed JSON after one retry."
    if parsed is None:
        return fallback, "rule-based", error
    return parsed, "AI-generated", None


def _validate_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Text is required.")
    text = value.strip()
    if len(text) < 20:
        raise ValueError("Please provide at least 20 characters of text.")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"Text is too long. Maximum supported length is {MAX_TEXT_CHARS:,} characters.")
    return text


def _chunks(text: str) -> list[str]:
    paragraphs = re.split(r"\n\s*\n", text)
    result: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(current) + len(paragraph) + 2 <= CHUNK_CHARS:
            current = f"{current}\n\n{paragraph}".strip()
        else:
            if current:
                result.append(current)
            current = paragraph[:CHUNK_CHARS]
            remainder = paragraph[CHUNK_CHARS:]
            while remainder:
                result.append(current)
                current = remainder[:CHUNK_CHARS]
                remainder = remainder[CHUNK_CHARS:]
    if current:
        result.append(current)
    return result or [text]


def _fallback_analysis(text: str) -> dict[str, Any]:
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    points = sentences[:8]
    words = re.findall(r"\b[A-Z][a-zA-Z]{2,}\b", text)
    entities = list(dict.fromkeys(words))[:12]
    return {
        "documentType": "other",
        "keyPoints": points,
        "entities": [{"name": name, "type": "proper noun"} for name in entities],
        "definitions": [],
        "openQuestions": [],
        "sourceLength": len(text),
    }


def _analyze(args: dict[str, Any]) -> dict[str, Any]:
    text = _validate_text(args.get("text"))
    fallback = _fallback_analysis(text)
    if len(_chunks(text)) == 1:
        analysis, source, error = _sample_json(
            "Analyze this document. Return JSON with keys documentType (article, lecture notes, meeting, report, other), "
            "keyPoints (array of concise factual strings), entities (array of name/type objects), definitions "
            "(array of term/meaning objects), and openQuestions (array of strings). Do not invent facts.\n\n" + text,
            fallback,
        )
    else:
        partials = []
        for chunk in _chunks(text):
            partial, _, _ = _sample_json("Extract factual keyPoints, entities, definitions, and openQuestions from this document chunk as JSON. Do not invent facts.\n\n" + chunk, fallback)
            partials.append(partial)
        merged = {
            "documentType": "other",
            "keyPoints": [item for partial in partials for item in partial.get("keyPoints", [])][:40],
            "entities": [item for partial in partials for item in partial.get("entities", [])][:40],
            "definitions": [item for partial in partials for item in partial.get("definitions", [])][:40],
            "openQuestions": [item for partial in partials for item in partial.get("openQuestions", [])][:30],
            "sourceLength": len(text),
        }
        analysis, source, error = _sample_json("Classify and deduplicate this combined document analysis as JSON. Use only its facts.\n\n" + json.dumps(merged), merged)
    analysis.setdefault("sourceLength", len(text))
    return {"success": True, "data": {"analysis": analysis, "source": source, "warning": error}}


def _generate(args: dict[str, Any]) -> dict[str, Any]:
    analysis = args.get("analysis")
    mode = args.get("mode")
    if not isinstance(analysis, dict) or mode not in {"short", "detailed", "actions", "flashcards", "quiz"}:
        return {"success": False, "error": "analysis and a supported mode are required."}
    key_points = [str(item).strip() for item in analysis.get("keyPoints", []) if str(item).strip()]
    if mode == "short":
        fallback = {
            "mode": mode,
            "summary": " ".join(key_points[:3]),
            "items": key_points[:3],
        }
    elif mode == "detailed":
        fallback = {
            "mode": mode,
            "summary": " ".join(key_points),
            "items": key_points,
        }
    else:
        fallback = {"mode": mode, "items": key_points}
    prompt = f"Generate {mode} study output from this verified analysis. Return JSON with mode and items. Keep facts grounded in the analysis.\n\n{json.dumps(analysis)}"
    output, source, error = _sample_json(prompt, fallback)
    return {"success": True, "data": {"output": output, "source": source, "warning": error}}


def _critique(args: dict[str, Any]) -> dict[str, Any]:
    source_text = _validate_text(args.get("source_text"))
    draft = args.get("draft")
    if draft is None:
        return {"success": False, "error": "draft is required."}
    fallback = {"revised": draft, "changes": [], "unsupportedClaims": [], "missingPoints": []}
    output, source, error = _sample_json(f"Compare this draft with the source. Return JSON with revised, changes, unsupportedClaims, and missingPoints. Do not add facts.\nSOURCE:\n{source_text}\nDRAFT:\n{json.dumps(draft)}", fallback)
    return {"success": True, "data": {"critique": output, "source": source, "warning": error}}


def _ask(args: dict[str, Any]) -> dict[str, Any]:
    source_text = _validate_text(args.get("source_text"))
    question = _validate_text(args.get("question"))
    analysis = args.get("analysis", {})
    history = args.get("history", [])
    fallback = {"answer": "I couldn't find that in the document.", "grounded": False, "evidence": []}
    output, source, error = _sample_json(f"Answer only from this document and analysis. If absent, say it is not in the document. Return JSON with answer, grounded boolean, and evidence array. Question: {question}\nAnalysis: {json.dumps(analysis)}\nDocument:\n{source_text}\nHistory:\n{json.dumps(history[-6:] if isinstance(history, list) else [])}", fallback)
    return {"success": True, "data": {"answer": output, "source": source, "warning": error}}


def _read_store() -> list[dict[str, Any]]:
    try:
        if STORE_PATH.exists():
            value = json.loads(STORE_PATH.read_text(encoding="utf-8"))
            return value if isinstance(value, list) else []
    except (OSError, json.JSONDecodeError):
        _log("Could not read local analysis store.")
    return []


def _write_store(items: list[dict[str, Any]]) -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STORE_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _persist(method: str, args: dict[str, Any]) -> dict[str, Any]:
    with _store_lock:
        items = _read_store()
        if method == "save_analysis":
            record = {"id": str(uuid.uuid4()), "title": args.get("title") or "Untitled analysis", "analysis": args.get("analysis"), "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            items.insert(0, record)
            _write_store(items)
            return {"success": True, "data": {"analysis": record, "persisted": True}}
        if method == "list_analyses":
            return {"success": True, "data": {"analyses": [{"id": item["id"], "title": item["title"], "createdAt": item["createdAt"]} for item in items]}}
        record_id = args.get("id")
        if method == "get_analysis":
            record = next((item for item in items if item.get("id") == record_id), None)
            return {"success": bool(record), "data": {"analysis": record} if record else {}, "error": None if record else "Analysis not found."}
        if method == "delete_analysis":
            filtered = [item for item in items if item.get("id") != record_id]
            _write_store(filtered)
            return {"success": len(filtered) != len(items), "data": {"deleted": len(filtered) != len(items)}}
    return {"success": False, "error": "Unknown persistence method."}


def _invoke(method: str, args: dict[str, Any]) -> dict[str, Any]:
    if method == "analyze_document":
        return _analyze(args)
    if method == "generate_outputs":
        return _generate(args)
    if method == "critique_and_refine":
        return _critique(args)
    if method == "ask_followup":
        return _ask(args)
    if method in {"save_analysis", "list_analyses", "get_analysis", "delete_analysis"}:
        return _persist(method, args)
    return {"success": False, "error": f"Unknown tool: {method}"}


def _dispatch(envelope: dict[str, Any]) -> None:
    request_id = envelope.get("id")
    try:
        method = envelope.get("method")
        if method == "initialize":
            result = {"protocolVersion": "2.0", "server_info": {"name": MANIFEST["display_name"], "version": MANIFEST["version"]}, "capabilities": {"sampling": {}}}
        elif method == "describe":
            result = MANIFEST
        elif method == "health":
            result = {"status": "ready"}
        elif method == "invoke":
            params = envelope.get("params", {})
            if not isinstance(params, dict) or not isinstance(params.get("arguments", {}), dict):
                raise ValueError("invoke params and arguments must be objects")
            result = _invoke(str(params.get("tool", "")), params["arguments"])
        else:
            raise ValueError(f"Unknown RPC method: {method}")
        _write({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:
        _log(f"request failed: {error}")
        _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": str(error)}})


def main() -> None:
    try:
        threading.Thread(target=_reader, daemon=True).start()
        while True:
            try:
                _dispatch(_requests.get(timeout=60))
            except queue.Empty:
                continue
    except Exception:
        traceback.print_exc(file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
