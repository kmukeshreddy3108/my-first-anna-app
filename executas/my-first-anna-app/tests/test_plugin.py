import json

import my_first_anna_app_plugin as plugin


def test_health_manifest_and_tools():
    assert plugin.MANIFEST["version"] == "0.3.0"
    names = {tool["name"] for tool in plugin.MANIFEST["tools"]}
    assert {"analyze_document", "generate_outputs", "critique_and_refine", "ask_followup", "save_analysis", "list_analyses", "get_analysis", "delete_analysis"} <= names


def test_analysis_fallback_and_validation(monkeypatch):
    monkeypatch.setattr(plugin, "_sampling_enabled", False)
    result = plugin._analyze({"text": "Solar energy reduces emissions. Batteries store power for later use."})
    assert result["success"] is True
    assert result["data"]["source"] == "rule-based"
    assert result["data"]["analysis"]["keyPoints"]


def test_oversize_input_rejected():
    try:
        plugin._analyze({"text": "x" * (plugin.MAX_TEXT_CHARS + 1)})
    except ValueError as error:
        assert "too long" in str(error)
    else:
        raise AssertionError("oversize input was accepted")


def test_malformed_model_output_retries_then_falls_back(monkeypatch):
    responses = iter([("not json", None), ("still not json", None)])
    monkeypatch.setattr(plugin, "_sample", lambda *args, **kwargs: next(responses))
    result, source, error = plugin._sample_json("return json", {"items": ["safe fallback"]})
    assert result == {"items": ["safe fallback"]}
    assert source == "rule-based"
    assert error


def test_generate_critique_and_followup_fallback(monkeypatch):
    monkeypatch.setattr(plugin, "_sampling_enabled", False)
    analysis = {"documentType": "article", "keyPoints": ["The report recommends batteries."]}
    assert plugin._generate({"analysis": analysis, "mode": "short"})["success"]
    assert plugin._critique({"source_text": "The report recommends batteries for storage.", "draft": {"text": "Batteries are recommended."}})["success"]
    answer = plugin._ask({"source_text": "The report recommends batteries for storage.", "analysis": analysis, "question": "What does it recommend?"})
    assert answer["data"]["answer"]["grounded"] is False


def test_all_output_modes_are_supported(monkeypatch):
    monkeypatch.setattr(plugin, "_sampling_enabled", False)
    analysis = {"documentType": "article", "keyPoints": ["One verified point."]}
    for mode in ("short", "detailed", "actions", "flashcards", "quiz"):
        result = plugin._generate({"analysis": analysis, "mode": mode})
        assert result["success"] is True
        assert result["data"]["output"]["mode"] == mode
    short = plugin._generate({"analysis": analysis, "mode": "short"})
    assert short["data"]["output"]["summary"] == "One verified point."


def test_long_text_is_chunked():
    chunks = plugin._chunks("paragraph " * 4000)
    assert len(chunks) > 1
    assert all(len(chunk) <= plugin.CHUNK_CHARS for chunk in chunks)


def test_local_persistence(monkeypatch, tmp_path):
    monkeypatch.setattr(plugin, "STORE_PATH", tmp_path / "analyses.json")
    saved = plugin._persist("save_analysis", {"title": "Test", "analysis": {"keyPoints": ["One"]}})
    record_id = saved["data"]["analysis"]["id"]
    assert plugin._persist("list_analyses", {})["data"]["analyses"]
    assert plugin._persist("get_analysis", {"id": record_id})["success"]
    assert plugin._persist("delete_analysis", {"id": record_id})["success"]
