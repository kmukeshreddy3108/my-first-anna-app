"""Generate deterministic local fixtures for document-ingestion tests."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

ROOT = Path(__file__).resolve().parents[1] / "fixtures" / "documents"
ROOT.mkdir(parents=True, exist_ok=True)


def archive(path: Path, entries: dict[str, bytes], stored: set[str] | None = None) -> None:
    with ZipFile(path, "w") as output:
        for name, content in entries.items():
            output.writestr(name, content, compress_type=ZIP_STORED if stored and name in stored else ZIP_DEFLATED)


docx_xml = b"""<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Study Heading</w:t></w:r></w:p><w:p><w:r><w:t>DOCX paragraph with grounded text.</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>List item</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Column A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Column B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"""
archive(ROOT / "sample.docx", {"word/document.xml": docx_xml, "word/media/image.bin": b"x" * 2_300_000}, {"word/media/image.bin"})

pptx_xml = b"""<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:t>Slide title</a:t><a:t>Speaker body</a:t></p:cSld></p:sld>"""
archive(ROOT / "sample.pptx", {"ppt/slides/slide1.xml": pptx_xml, "ppt/notesSlides/notesSlide1.xml": pptx_xml})

xlsx_xml = b"""<workbook xmlns="x"><sheets><sheet name="Scores"/></sheets></workbook>"""
sheet_xml = b"""<worksheet xmlns="x"><sheetData><row><c t="inlineStr"><is><t>Name</t></is></c><c><v>Score</v></c></row><row><c t="inlineStr"><is><t>Ana</t></is></c><c><v>95</v></c></row></sheetData></worksheet>"""
archive(ROOT / "sample.xlsx", {"xl/workbook.xml": xlsx_xml, "xl/worksheets/sheet1.xml": sheet_xml})

archive(ROOT / "sample.odt", {"content.xml": b"""<office:document-content xmlns:office="o" xmlns:text="t"><text:h>ODT heading</text:h><text:p>ODT paragraph.</text:p></office:document-content>"""})
archive(ROOT / "sample.epub", {
    "META-INF/container.xml": b"""<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
    "OEBPS/content.opf": b"""<package><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>""",
    "OEBPS/chapter.xhtml": b"""<html><body><h1>EPUB chapter</h1><p>Chapter text.</p></body></html>""",
})

# Minimal two-page text PDF with a selectable text layer.
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    b"<< /Length 48 >>\nstream\nBT /F1 18 Tf 72 720 Td (Resume heading) Tj ET\nendstream",
    b"<< /Length 43 >>\nstream\nBT /F1 18 Tf 72 720 Td (Skills list) Tj ET\nendstream",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for number, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
pdf.extend(b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:]))
pdf.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
(ROOT / "text.pdf").write_bytes(bytes(pdf))
(ROOT / "corrupt.pdf").write_bytes(b"%PDF-1.4\ntruncated")
(ROOT / "empty.txt").write_bytes(b"")
(ROOT / "renamed.exe.txt").write_bytes(b"MZ" + b"\0" * 20)
