# StudyLens AI

**Understand documents, verify drafts, and study smarter.**

StudyLens AI is an AI-native study and document analyst designed for students, researchers, and professionals. It turns lecture notes, research articles, meeting transcripts, and business reports into structured, verifiable learning kits.

---

## 1. What StudyLens AI Does & Who It Is For

StudyLens AI replaces shallow chat-based summarization with a multi-step evidence-based pipeline:
1. **Analyze Document**: Classifies document structure, normalizes text, chunks large inputs, and extracts key points with exact passage citations.
2. **Generate Grounded Study Kit**: Creates 5 specialized summary modes, actionable study tasks, flashcards, and conceptual quizzes.
3. **Verify & Critique Drafts**: Cross-checks claims against the source document, identifying missing points and flagging unsupported claims.
4. **Grounded Follow-up Q&A**: Answers questions using only document evidence; responds honestly with *"Not found in your document"* when an answer is absent.
5. **Local History & Export**: Organizes analyses in an atomic, offline JSON store (`~/.anna-study-analyses.json`) with search, rename, delete, and Markdown/text export.

### Target Audience
- **Students & Learners**: Preparing for exams with flashcards, quizzes, and concept mastery diagnostics.
- **Researchers & Academics**: Reading dense papers, checking claims against evidence passages, and extracting key definitions.
- **Professionals & Analysts**: Distilling meeting minutes, transcripts, and briefing documents into actionable study plans and verified takeaways.

---

## 2. Core Features & AI Disclosure

| Feature | Execution Type | Description |
| :--- | :--- | :--- |
| **Document Classification & Chunking** | Rule-Based | NFKC normalization, paragraph segmentation, and sentence salience ranking. |
| **Short Summary** | AI / Fallback | 3–4 sentence executive summary with key takeaway and main topic. |
| **Detailed Summary** | AI / Fallback | Multi-section breakdown with headings, paragraphs, and significance. |
| **Bullet Summary** | AI / Fallback | Topic-grouped bullet points with source passage links. |
| **Simple Summary** | AI / Fallback | Everyday analogies and simplified explanations. |
| **Exam Notes Summary** | AI / Fallback | Key facts, processes, comparisons, mistakes, and likely exam questions. |
| **Action Items & Study Plan** | AI / Fallback | Priority-ranked study tasks and time-estimated study schedule. |
| **Flashcard Deck** | AI / Fallback | Conceptual Q&A cards with difficulty tags and source references. |
| **Quiz Generation & Grading** | AI / Fallback | 4-option multiple-choice questions with weak-concept retry quizzes. |
| **Verification & Fact Checking** | AI / Fallback | Compares drafts against source text to flag unsupported claims. |
| **Document Q&A** | AI / Fallback | Grounded chat strictly citing source passages; never hallucinates. |
| **Multi-File Ingestion** | Local Rule-Based | In-browser parsing of TXT, MD, CSV, JSON, XML, HTML, DOCX, PPTX, XLSX, ODT, EPUB, and text-layer PDF. |
| **History & Storage** | Local Rule-Based | Atomic local JSON store with schema versioning, backup-on-migration, and corruption recovery. |

> [!NOTE]
> **AI vs. Basic Mode Transparency**:
> StudyLens AI uses Anna's reverse-sampling model capabilities. When AI sampling is unavailable or denied by policy, the app automatically and transparently switches to **Basic mode**, providing deterministic, extractive highlights without simulating AI generation or failing silently.

---

## 3. Supported Formats & Limits

| Format | Support Level | Details |
| :--- | :--- | :--- |
| **TXT, MD, LOG, SRT, VTT, source code** | Full | UTF-8, UTF-16, and Windows-1252 auto-detection. |
| **CSV, TSV, JSON, XML, HTML** | Full / Partial | Formatted tables; very large tables sampled safely. |
| **Text-layer PDF** | Full | Extracted by bundled `pypdf` with individual page citations. |
| **DOCX, PPTX, XLSX, ODT, EPUB** | Full / Partial | Zero-dependency ZIP/XML reader; extracts text and slide/sheet metadata. |
| **Scanned PDF, Images (PNG, JPG)** | Unsupported | Offline OCR is not bundled. |
| **Binary Office (DOC, PPT, XLS)** | Unsupported | Legacy binary formats without XML layers are reported as unsupported. |
| **Audio / Video Media** | Unsupported | Offline audio transcription is not bundled. |

- **Max File Size**: 20 MB per file.
- **Max Batch Size**: 40 MB combined.
- **Max Text Extraction**: 120,000 characters per analysis.

---

## 4. Data Privacy & Storage

- **Zero Third-Party APIs**: No external commercial LLM keys or proprietary network endpoints are required. All intelligence is provided via Anna's runtime.
- **Local Storage**: Analyses are saved to `~/.anna-study-analyses.json` using atomic file replacement (`temp file -> rename`).
- **Resilient Recovery**: If the history store is corrupted, the original file is preserved as `.recovery-*.bak` and an empty store is initialized cleanly.
- **Cloud Agent Portability**: If home directory access is restricted, the history engine falls back safely to the system temporary directory without crashing.

---

## 5. Development & Local Testing

### Prerequisites
- Node.js 18+
- Python 3.10+
- Anna CLI (`npm install -g @anna-ai/cli`)

### Setup
```bash
# Clone the repository
git clone <repo-url>
cd my-first-anna-app

# Setup Python virtual environment
cd executas/my-first-anna-app
python -m venv .venv

# On Linux / macOS:
source .venv/bin/activate
pip install -e ".[test]"

# On Windows:
.\.venv\Scripts\activate
pip install -e ".[test]"
cd ../..
```

### Running Tests & Validations
```bash
# 1. Run unit test suite (26 tests)
npm test

# 2. Run app schema validation
npm run validate

# 3. Run strict manifest and Host API ACL validation
anna-app validate --strict

# 4. Run end-to-end integration and stdio self-test
npm run selftest
```

### Running Locally with Anna CLI
```bash
anna-app dev --no-watch --executa "dir=executas/my-first-anna-app,tool_id=tool-dev-my-first-anna-app,type=python,command=\"python my_first_anna_app_plugin.py\""
```

---

## 6. Binary Distribution & Release

For store submission and Anna Cloud Agent execution (Linux-x86_64), executas are compiled into standalone binaries using PyInstaller via GitHub Actions:
- **darwin-arm64**: macOS Apple Silicon (`.tar.gz`)
- **darwin-x86_64**: macOS Intel (`.tar.gz`)
- **linux-x86_64**: Linux x86_64 Cloud Agent target (`.tar.gz`)
- **windows-x86_64**: Windows 64-bit (`.zip`)

Archives are named: `my-first-anna-app-summarizer-{version}-{platform}.[tar.gz|zip]` and published along with SHA-256 checksums to GitHub Releases.

---

## 7. Troubleshooting

- **"describe handshake failed"**: Ensure stdout carries strictly JSON-RPC protocol messages. All logs, prints, and debug traces are directed exclusively to `sys.stderr`.
- **"ModuleNotFoundError: my_first_anna_app_plugin"**: Run `npm test` from the root directory; the repository uses `pytest.ini` with `pythonpath = executas/my-first-anna-app`.
- **"Basic mode displayed instead of AI"**: This indicates the local environment or dev harness does not have reverse sampling enabled or granted. Basic mode is the expected deterministic fallback.
