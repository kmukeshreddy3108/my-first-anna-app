"""Stdio JSON-RPC Executa plugin for the text summary tool."""

from __future__ import annotations

import json
import sys
import uuid
from typing import Any


MANIFEST: dict[str, Any] = {
    "display_name": "tool-dev-my-first-anna-app",
    "version": "0.1.0",
    "description": "Summarize a piece of text via host sampling.",
    "host_capabilities": ["llm.sample", "llm.complete"],
    "tools": [
        {
            "name": "summarize",
            "description": "Summarize a piece of text via host sampling.",
            "parameters": [
                {
                    "name": "text",
                    "type": "string",
                    "description": "Text to summarize.",
                    "required": True,
                }
            ],
        }
    ],
}


def _write(envelope: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(envelope) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _request_sampling(prompt: str) -> dict[str, Any]:
    request_id = str(uuid.uuid4())
    _write(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "sampling/createMessage",
            "params": {
                "messages": [
                    {
                        "role": "user",
                        "content": {"type": "text", "text": prompt},
                    }
                ],
                "maxTokens": 300,
            },
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        envelope = json.loads(line)
        if envelope.get("id") == request_id and "method" not in envelope:
            if "error" in envelope:
                error = envelope["error"]
                raise RuntimeError(error.get("message", "sampling failed"))
            result = envelope.get("result")
            if not isinstance(result, dict):
                raise RuntimeError("sampling returned an invalid response")
            return result
        _dispatch(envelope)

    raise RuntimeError("stdin closed before sampling response arrived")


def _summarize(args: dict[str, Any]) -> dict[str, Any]:
    text = args.get("text", "")
    if not isinstance(text, str) or not text.strip():
        return {"success": False, "error": "text is required"}

    try:
        sample = _request_sampling(
            f"Summarize the following text concisely:\n\n{text}"
        )

        content = sample.get("content")
        summary = None

        if isinstance(content, list) and len(content) > 0:
            first_block = content[0]
            if isinstance(first_block, dict):
                summary = first_block.get("text")
        elif isinstance(content, dict):
            summary = content.get("text")

        if not summary and isinstance(sample.get("text"), str):
            summary = sample.get("text")

        if not isinstance(summary, str) or not summary.strip():
            raise RuntimeError("sampling returned no text")

        # Return all possible key structures expected by frontend parsers
        return {
            "summary": summary,
            "success": True,
            "data": {
                "summary": summary
            }
        }
    except Exception as error:
        _log(f"sampling failed: {error}")
        return {"success": False, "error": f"sampling failed: {error}"}

def _invoke(method: str, args: dict[str, Any]) -> dict[str, Any]:
    if method == "summarize":
        return _summarize(args)
    return {"success": False, "error": f"unknown method: {method}"}


def _dispatch(envelope: dict[str, Any]) -> None:
    method = envelope.get("method")
    request_id = envelope.get("id")
    try:
        if method == "initialize":
            result = {
                "protocolVersion": "2.0",
                "server_info": {
                    "name": MANIFEST["display_name"],
                    "version": MANIFEST["version"],
                },
                "capabilities": {"sampling": {}},
            }
        elif method == "describe":
            result = MANIFEST
        elif method == "health":
            result = {"status": "ready"}
        elif method == "invoke":
            params = envelope.get("params", {})
            if not isinstance(params, dict):
                raise ValueError("invoke params must be an object")
            arguments = params.get("arguments", {})
            if not isinstance(arguments, dict):
                raise ValueError("invoke arguments must be an object")

            invoke_res = _invoke(str(params.get("tool", "")), arguments)
            if isinstance(invoke_res, dict) and "data" in invoke_res and isinstance(invoke_res["data"], dict):
                # Flatten data keys to top-level for bundle/app.js compatibility
                result = {**invoke_res, **invoke_res["data"]}
            else:
                result = invoke_res
        else:
            raise ValueError(f"unknown rpc method: {method}")
        _write({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:
        _log(f"request failed: {error}")
        _write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": str(error)},
            }
        )


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            envelope = json.loads(line)
            if not isinstance(envelope, dict):
                raise ValueError("JSON-RPC request must be an object")
            _dispatch(envelope)
        except (json.JSONDecodeError, ValueError) as error:
            _log(f"invalid request: {error}")


if __name__ == "__main__":
    main()