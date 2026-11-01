"""AI Study & Document Analyst Executa.

The process speaks JSON-RPC on stdout. Logs and tracebacks go to stderr.
Sampling is optional: when unavailable, tools return explicit structured
errors rather than pretending that a result was AI-generated.
"""

import sys

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import concurrent.futures
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import queue
import re
import threading
import time
import traceback
import unicodedata
import uuid
from pathlib import Path
from typing import Any

MAX_TEXT_CHARS = 120_000
CHUNK_CHARS = 12_000
SAMPLE_TIMEOUT = 18
MAX_CHUNKS_PER_CALL = 3
STORE_PATH = Path(os.environ.get("ANNA_ANALYST_STORE", Path.home() / ".anna-study-analyses.json"))
LOG_PATH = Path(os.environ.get("ANNA_ANALYST_LOG", Path(__file__).resolve().parent / "logs" / "plugin.log"))

MANIFEST: dict[str, Any] = {
    "display_name": "tool-dev-my-first-anna-app",
    "version": "0.3.0",
    "description": "AI Study & Document Analyst with structured analysis, verified outputs, and grounded follow-up questions.",
    "host_capabilities": ["llm.sample"],
    "tools": [
        {"name": "analyze_document", "description": "Classify and structurally analyze a document.", "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
        {"name": "generate_summary", "description": "Generate a grounded summary in a selected study mode.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "mode": {"type": "string"}}, "required": ["analysis", "mode"]}},
        {"name": "generate_action_items", "description": "Generate grounded study tasks and a study plan.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}}, "required": ["analysis"]}},
        {"name": "generate_flashcards", "description": "Generate grounded flashcards.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "count": {"type": "integer"}, "difficulty": {"type": "string"}}, "required": ["analysis"]}},
        {"name": "generate_quiz", "description": "Generate a grounded quiz with concept coverage.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "count": {"type": "integer"}, "difficulty": {"type": "string"}, "type": {"type": "string"}}, "required": ["analysis"]}},
        {"name": "grade_quiz", "description": "Grade quiz answers and identify weak concepts.", "parameters": {"type": "object", "properties": {"quiz": {"type": "object"}, "answers": {"type": "object"}}, "required": ["quiz", "answers"]}},
        {"name": "verify_and_refine", "description": "Verify a draft against source text and return a revised draft.", "parameters": {"type": "object", "properties": {"source_text": {"type": "string"}, "draft": {}}, "required": ["source_text", "draft"]}},
        {"name": "ask_question", "description": "Answer a grounded question about a document.", "parameters": {"type": "object", "properties": {"source_text": {"type": "string"}, "analysis": {"type": "object"}, "question": {"type": "string"}, "history": {"type": "array"}}, "required": ["source_text", "analysis", "question"]}},
        {"name": "generate_outputs", "description": "Compatibility wrapper for summary, actions, flashcards, or quiz.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "mode": {"type": "string"}}, "required": ["analysis", "mode"]}},
        {"name": "critique_and_refine", "description": "Check a draft against source text and revise unsupported or missing content.", "parameters": {"type": "object", "properties": {"source_text": {"type": "string"}, "draft": {}}, "required": ["source_text", "draft"]}},
        {"name": "ask_followup", "description": "Answer a question using only the supplied document analysis.", "parameters": {"type": "object", "properties": {"source_text": {"type": "string"}, "analysis": {"type": "object"}, "question": {"type": "string"}, "history": {"type": "array"}}, "required": ["source_text", "analysis", "question"]}},
        {"name": "save_analysis", "description": "Save an analysis for later review.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "title": {"type": "string"}}, "required": ["analysis"]}},
        {"name": "list_analyses", "description": "List saved analyses.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
        {"name": "get_analysis", "description": "Get a saved analysis by ID.", "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
        {"name": "delete_analysis", "description": "Delete a saved analysis by ID.", "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
        {"name": "rename_analysis", "description": "Rename a saved analysis.", "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "title": {"type": "string"}}, "required": ["id", "title"]}},
        {"name": "search_analyses", "description": "Search saved analyses by title.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
        {"name": "export_analysis", "description": "Export a supplied analysis as Markdown or plain text.", "parameters": {"type": "object", "properties": {"analysis": {"type": "object"}, "format": {"type": "string"}}, "required": ["analysis", "format"]}},
    ],
}

_responses: dict[str, queue.Queue[dict[str, Any]]] = {}
_requests: queue.Queue[dict[str, Any]] = queue.Queue()
_sampling_enabled = True
_store_lock = threading.Lock()
TOOL_TIMEOUT = 55
_analysis_cache: dict[str, dict[str, Any]] = {}


def _configure_logging() -> logging.Logger:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("studylens.plugin")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        handler = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
    return logger


_logger = _configure_logging()


def _write(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
    _logger.info(message)


def _reader() -> None:
    try:
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
    finally:
        _requests.put({"_eof": True})


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
    required_keys = set(fallback)

    def parse_candidate(candidate: str | None) -> dict[str, Any] | None:
        if not candidate:
            return None
        try:
            value = json.loads(_clean_json(candidate))
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(value, dict) or not required_keys.issubset(value):
            return None
        return value

    text, error = _sample(prompt, max_tokens)
    parsed = parse_candidate(text)
    if parsed is None and text:
        retry_text, retry_error = _sample(prompt + "\nReturn valid JSON only. No markdown fences, no commentary.", max_tokens)
        error = retry_error or error
        parsed = parse_candidate(retry_text)
        if parsed is None:
            error = error or "The AI returned malformed JSON after one retry."
    if parsed is None:
        return fallback, "rule-based", error
    return parsed, "AI-generated", None


def _validate_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Text is required.")
    text = unicodedata.normalize("NFKC", value).replace("\x00", "")
    text = "".join(char for char in text if char in "\r\n\t" or not unicodedata.category(char).startswith("C"))
    text = text.strip()
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
    points = sentences[:12]
    words = re.findall(r"\b[A-Z][a-zA-Z]{2,}\b", text)
    entities = list(dict.fromkeys(words))[:12]
    chunks = _chunks(text)
    return {
        "documentType": "other",
        "title": points[0][:80] if points else "Untitled document",
        "keyPoints": [{"text": point, "source": _source_ref(text, point, index, chunks)} for index, point in enumerate(points)],
        "entities": [{"name": name, "type": "proper noun"} for name in entities],
        "definitions": [],
        "openQuestions": [],
        "chunks": [{"id": f"chunk-{index + 1}", "snippet": chunk[:240]} for index, chunk in enumerate(chunks)],
        "sourceLength": len(text),
    }


def _source_ref(text: str, statement: str, index: int, chunks: list[str] | None = None) -> dict[str, Any]:
    chunks = chunks or _chunks(text)
    location = next((i for i, chunk in enumerate(chunks) if statement[:40].lower() in chunk.lower()), index % max(1, len(chunks)))
    return {"chunkId": f"chunk-{location + 1}", "snippet": chunks[location][:240]}


def _point_text(point: Any) -> str:
    return str(point.get("text", "") if isinstance(point, dict) else point).strip()


def _ensure_references(analysis: dict[str, Any], text: str) -> dict[str, Any]:
    points = analysis.get("keyPoints", [])
    normalized = []
    for index, point in enumerate(points if isinstance(points, list) else []):
        statement = _point_text(point)
        if statement:
            reference = point.get("source") if isinstance(point, dict) else None
            normalized.append({"text": statement, "source": reference or _source_ref(text, statement, index)})
    analysis["keyPoints"] = normalized
    analysis.setdefault("chunks", [{"id": "chunk-1", "snippet": text[:240]}])
    return analysis


def _analysis_cache_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _analyze(args: dict[str, Any]) -> dict[str, Any]:
    text = _validate_text(args.get("text"))
    cache_key = _analysis_cache_key(text)
    cursor = max(0, int(args.get("cursor", 0)))
    max_chunks = max(1, min(int(args.get("max_chunks", MAX_CHUNKS_PER_CALL)), MAX_CHUNKS_PER_CALL))
    all_chunks = _chunks(text)
    if cursor == 0 and cache_key in _analysis_cache and len(all_chunks) <= MAX_CHUNKS_PER_CALL:
        return {"success": True, "data": {"analysis": _analysis_cache[cache_key], "source": "cache", "warning": None, "documentHash": cache_key}}
    fallback = _fallback_analysis(text)
    if len(all_chunks) == 1:
        analysis, source, error = _sample_json(
            "Analyze this document. Return JSON with keys documentType (article, lecture notes, meeting, report, other), "
            "title (string), keyPoints (array of concise factual strings), entities (array of name/type objects), definitions "
            "(array of term/meaning objects), and openQuestions (array of strings). Do not invent facts.\n\n" + text,
            fallback,
        )
    else:
        selected = all_chunks[cursor:cursor + max_chunks]
        def analyze_chunk(chunk: str) -> tuple[dict[str, Any], str, str | None]:
            return _sample_json(
                "Extract factual keyPoints, entities, definitions, and openQuestions from this document chunk as JSON. "
                "Keep the response compact and do not invent facts.\n\n" + chunk,
                _fallback_analysis(chunk),
                max_tokens=700,
            )
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_chunks) as pool:
            results = list(pool.map(analyze_chunk, selected))
        partials = [result[0] for result in results]
        sources = {result[1] for result in results}
        errors = [result[2] for result in results if result[2]]
        analysis = {
            "documentType": "other",
            "title": fallback["title"],
            "keyPoints": [item for partial in partials for item in partial.get("keyPoints", [])][:40],
            "entities": [item for partial in partials for item in partial.get("entities", [])][:40],
            "definitions": [item for partial in partials for item in partial.get("definitions", [])][:40],
            "openQuestions": [item for partial in partials for item in partial.get("openQuestions", [])][:30],
            "sourceLength": len(text),
        }
        source = "AI-generated" if sources == {"AI-generated"} else "rule-based"
        error = "; ".join(errors) if errors else None
    analysis.setdefault("sourceLength", len(text))
    analysis = _ensure_references(analysis, text)
    complete = cursor + max_chunks >= len(all_chunks)
    if complete:
        _analysis_cache[cache_key] = analysis
    data = {"analysis": analysis, "source": source, "warning": error, "documentHash": cache_key, "complete": complete}
    if not complete:
        data["nextCursor"] = cursor + max_chunks
    return {"success": True, "data": data}


def _fallback_items(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"text": _point_text(point), "source": point.get("source", {}) if isinstance(point, dict) else {}} for point in analysis.get("keyPoints", []) if _point_text(point)]


def _generate_summary(args: dict[str, Any]) -> dict[str, Any]:
    analysis = args.get("analysis")
    mode = args.get("mode")
    if not isinstance(analysis, dict) or mode not in {"short", "detailed", "bullets", "simple", "exam_notes"}:
        return {"success": False, "error": "analysis and a supported mode are required."}
    items = _fallback_items(analysis)
    limit = 3 if mode == "short" else len(items)
    fallback = {"mode": mode, "summary": " ".join(item["text"] for item in items[:limit]), "items": items[:limit], "aiGenerated": False}
    prompt = f"Generate a {mode} study summary. Return JSON with mode, summary, and items; every item must include text and source. Keep facts grounded in the analysis.\n\n{json.dumps(analysis, ensure_ascii=False)}"
    output, source, error = _sample_json(prompt, fallback)
    output["mode"] = mode
    output["aiGenerated"] = source == "AI-generated"
    return {"success": True, "data": {"output": output, "source": source, "warning": error}}


def _generate_action_items(args: dict[str, Any]) -> dict[str, Any]:
    analysis = args.get("analysis")
    if not isinstance(analysis, dict):
        return {"success": False, "error": "analysis is required."}
    points = _fallback_items(analysis)
    fallback = {
        "items": [{"task": f"Review: {point['text']}", "priority": "High" if index == 0 else "Medium", "source": point["source"]} for index, point in enumerate(points)],
        "studyPlan": [{"topic": point["text"], "estimatedMinutes": 15, "source": point["source"]} for point in points],
        "aiGenerated": False,
    }
    output, source, error = _sample_json(f"Create prioritized study tasks and a study plan from this analysis. Return JSON with items and studyPlan; cite every item.\n{json.dumps(analysis, ensure_ascii=False)}", fallback)
    output["mode"] = "actions"
    output["aiGenerated"] = source == "AI-generated"
    return {"success": True, "data": {"output": output, "source": source, "warning": error}}


def _generate_flashcards(args: dict[str, Any]) -> dict[str, Any]:
    analysis = args.get("analysis")
    count = max(1, min(int(args.get("count", 10)), 50))
    points = _fallback_items(analysis if isinstance(analysis, dict) else {})
    fallback = {"cards": [{"question": f"What is an important point about {point['text'][:60]}?", "answer": point["text"], "source": point["source"], "concept": point["text"][:40]} for point in points[:count]], "aiGenerated": False}
    output, source, error = _sample_json(f"Create {count} grounded flashcards from this analysis. Every card needs question, answer, concept, and source.\n{json.dumps(analysis, ensure_ascii=False)}", fallback)
    output["mode"] = "flashcards"
    output["aiGenerated"] = source == "AI-generated"
    return {"success": True, "data": {"output": output, "source": source, "warning": error}}


def _generate_quiz(args: dict[str, Any]) -> dict[str, Any]:
    analysis = args.get("analysis")
    count = max(1, min(int(args.get("count", 5)), 30))
    points = _fallback_items(analysis if isinstance(analysis, dict) else {})
    questions = [{"id": str(index + 1), "type": "short-answer", "question": f"State this key point: {point['text']}", "correctAnswer": point["text"], "explanation": "This answer is supported by the cited source.", "options": [], "source": point["source"], "concept": point["text"][:40]} for index, point in enumerate(points[:count])]
    concepts = [point["text"][:40] for point in points]
    fallback = {"questions": questions, "coverage": {"covered": len(questions), "total": len(concepts), "label": f"Covers {len(questions)} of {len(concepts)} key concepts"}, "aiGenerated": False}
    output, source, error = _sample_json(f"Create a grounded quiz with {count} questions. Include type, question, options, correctAnswer, explanation, source, and concept. Cover all key concepts.\n{json.dumps(analysis, ensure_ascii=False)}", fallback)
    output["mode"] = "quiz"
    output["aiGenerated"] = source == "AI-generated"
    return {"success": True, "data": {"output": output, "source": source, "warning": error}}


def _generate(args: dict[str, Any]) -> dict[str, Any]:
    mode = args.get("mode")
    if mode in {"short", "detailed", "bullets", "simple", "exam_notes"}:
        return _generate_summary(args)
    if mode == "actions":
        return _generate_action_items(args)
    if mode == "flashcards":
        return _generate_flashcards(args)
    if mode == "quiz":
        return _generate_quiz(args)
    return {"success": False, "error": "analysis and a supported mode are required."}


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


def _grade_quiz(args: dict[str, Any]) -> dict[str, Any]:
    quiz = args.get("quiz")
    answers = args.get("answers")
    if not isinstance(quiz, dict) or not isinstance(answers, dict):
        return {"success": False, "error": "quiz and answers are required."}
    questions = quiz.get("questions", [])
    results = []
    correct = 0
    for question in questions if isinstance(questions, list) else []:
        question_id = str(question.get("id", len(results) + 1))
        expected = str(question.get("correctAnswer", "")).strip().lower()
        actual = str(answers.get(question_id, "")).strip()
        is_correct = bool(expected) and actual.lower() == expected
        correct += int(is_correct)
        results.append({"id": question_id, "correct": is_correct, "expected": question.get("correctAnswer", ""), "answer": actual, "concept": question.get("concept", ""), "source": question.get("source", {})})
    total = len(results)
    weak = list(dict.fromkeys(item["concept"] for item in results if not item["correct"] and item["concept"]))
    return {"success": True, "data": {"score": correct, "total": total, "percentage": round(correct * 100 / total) if total else 0, "results": results, "weakAreas": weak, "reviewSections": [item["source"] for item in results if not item["correct"]]}}


def _export_text(analysis: dict[str, Any], markdown: bool) -> str:
    title = str(analysis.get("title") or "StudyLens analysis")
    points = _fallback_items(analysis)
    lines = [f"# {title}" if markdown else title, ""]
    lines.extend((f"- {item['text']}" if markdown else item["text"]) for item in points)
    return "\n".join(lines).strip() + "\n"


def _export_analysis(args: dict[str, Any]) -> dict[str, Any]:
    analysis = args.get("analysis")
    export_format = args.get("format")
    if not isinstance(analysis, dict) or export_format not in {"markdown", "text"}:
        return {"success": False, "error": "analysis and format (markdown or text) are required."}
    content = _export_text(analysis, export_format == "markdown")
    return {"success": True, "data": {"format": export_format, "content": content, "encoding": "utf-8"}}


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
        if method == "rename_analysis":
            title = args.get("title")
            if not isinstance(title, str) or not title.strip():
                return {"success": False, "error": "title is required."}
            record = next((item for item in items if item.get("id") == record_id), None)
            if not record:
                return {"success": False, "error": "Analysis not found."}
            record["title"] = title.strip()
            _write_store(items)
            return {"success": True, "data": {"analysis": record}}
        if method == "search_analyses":
            query = str(args.get("query", "")).strip().lower()
            matches = [item for item in items if not query or query in str(item.get("title", "")).lower()]
            return {"success": True, "data": {"analyses": matches}}
    return {"success": False, "error": "Unknown persistence method."}


def _invoke(method: str, args: dict[str, Any]) -> dict[str, Any]:
    if method == "analyze_document":
        return _analyze(args)
    if method == "generate_outputs":
        return _generate(args)
    if method == "generate_summary":
        return _generate_summary(args)
    if method == "generate_action_items":
        return _generate_action_items(args)
    if method == "generate_flashcards":
        return _generate_flashcards(args)
    if method == "generate_quiz":
        return _generate_quiz(args)
    if method == "grade_quiz":
        return _grade_quiz(args)
    if method == "critique_and_refine":
        return _critique(args)
    if method == "verify_and_refine":
        return _critique(args)
    if method == "ask_followup":
        return _ask(args)
    if method == "ask_question":
        return _ask(args)
    if method == "export_analysis":
        return _export_analysis(args)
    if method in {"save_analysis", "list_analyses", "get_analysis", "delete_analysis", "rename_analysis", "search_analyses"}:
        return _persist(method, args)
    return {"success": False, "error": f"Unknown tool: {method}"}


def _dispatch(envelope: dict[str, Any]) -> None:
    request_id = envelope.get("id")
    started = time.monotonic()
    tool_name = str(envelope.get("params", {}).get("tool", "")) if isinstance(envelope.get("params"), dict) else ""
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
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            future = executor.submit(_invoke, str(params.get("tool", "")), params["arguments"])
            try:
                result = future.result(timeout=TOOL_TIMEOUT)
            except concurrent.futures.TimeoutError:
                future.cancel()
                result = {
                    "success": False,
                    "error": {
                        "code": "tool_timeout",
                        "message": f"Tool call exceeded the {TOOL_TIMEOUT}-second timeout.",
                    },
                }
            finally:
                executor.shutdown(wait=False, cancel_futures=True)
        else:
            raise ValueError(f"Unknown RPC method: {method}")
        _write({"jsonrpc": "2.0", "id": request_id, "result": result})
        _logger.info("request_id=%s tool=%s duration_ms=%d status=ok", request_id, tool_name, int((time.monotonic() - started) * 1000))
    except Exception as error:
        _log(f"request failed: {error}")
        _logger.exception("request_id=%s tool=%s duration_ms=%d status=error", request_id, tool_name, int((time.monotonic() - started) * 1000))
        _write({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32603,
                "message": "Request failed.",
                "data": {"type": type(error).__name__, "detail": str(error)},
            },
        })


def main() -> None:
    try:
        threading.Thread(target=_reader, daemon=True).start()
        while True:
            try:
                envelope = _requests.get(timeout=60)
                if envelope.get("_eof"):
                    return
                _dispatch(envelope)
            except queue.Empty:
                continue
    except Exception:
        traceback.print_exc(file=sys.stderr)
        _logger.exception("plugin main loop failed")
        raise


if __name__ == "__main__":
    main()
