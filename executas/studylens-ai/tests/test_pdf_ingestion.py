import base64
from pathlib import Path

import studylens_ai_plugin as plugin


def test_pdf_fixture_extracts_page_text():
    raw = (Path(__file__).parents[3] / "fixtures" / "documents" / "text.pdf").read_bytes()
    result = plugin._parse_pdf({"data": base64.b64encode(raw).decode(), "name": "text.pdf"})
    assert result["success"] is True
    assert result["data"]["status"] == "ok"
    assert len(result["data"]["pages"]) == 2
    assert "Resume heading" in result["data"]["text"]


def test_corrupt_pdf_returns_structured_error():
    raw = (Path(__file__).parents[3] / "fixtures" / "documents" / "corrupt.pdf").read_bytes()
    try:
        plugin._parse_pdf({"data": base64.b64encode(raw).decode(), "name": "corrupt.pdf"})
    except Exception as error:
        assert "PDF" in str(error) or "EOF" in str(error) or "ended unexpectedly" in str(error)
    else:
        raise AssertionError("corrupt PDF was accepted")
