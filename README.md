# StudyLens AI

StudyLens AI is an AI Study & Document Analyst for turning pasted notes,
articles, meeting transcripts, and reports into structured, verifiable study
outputs. It uses a multi-step workflow: analyze the source, generate an
output, critique the draft against the source, and answer grounded follow-up
questions. AI results are labelled; when sampling is unavailable, the app
returns a clear structured error instead of pretending.

## About

StudyLens AI uses a multi-step AI workflow rather than a single chat reply.
It analyzes a source document into evidence, generates a structured study kit,
checks the draft in a separate verification pass, and supports grounded
follow-up questions. Students and professionals can use it for lecture notes,
articles, reports, and meeting transcripts. Each summary point, flashcard,
quiz question, and answer can show its source passage. Quiz coverage and
grading help identify sections that need review. If a question is not answered
by the document, the app says so instead of guessing. AI-generated content is
labelled, and Basic mode provides a deterministic fallback when sampling is
unavailable. Paste or upload a document, review the extracted text, click
Analyze, then explore Summary, Concepts, Actions, Study, Quiz, Ask, and
Verification. Saved kits appear in History and can be searched, renamed,
reopened, deleted, or exported as Markdown or plain text.

## Run locally

Prerequisites: Node.js, `uv`, Python 3.10+, and the Anna CLI.

```powershell
cd C:\Users\kathi\my-first-anna-app
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
anna-app validate
anna-app validate --strict
anna-app dev --no-watch --executa "dir=executas/my-first-anna-app,tool_id=tool-dev-my-first-anna-app,type=python,command=\"python my_first_anna_app_plugin.py\""
```

Open the URL printed by the CLI. Use the sample document or paste at least
20 characters, click **Analyze document**, review the verification panel,
then try action items, flashcards, quiz, follow-up Q&A, copy/export, and
history.

## Test the Executa

```powershell
cd C:\Users\kathi\my-first-anna-app\executas\my-first-anna-app
uv sync --extra test
.\.venv\Scripts\python.exe -m pytest -q
```

The tests cover health/describe, all workflow tools, malformed model output,
sampling failure, input validation, chunking, and local persistence.

The browser bundle uses the documented Anna runtime storage methods
`anna.storage.get` and `anna.storage.set` for resumable client state. The
Executa also keeps a UTF-8 JSON fallback for local development and standalone
plugin runs. The installed Anna CLI documents APS storage declarations and
states that the local dev harness mocks APS by default.

## Fresh-install review checklist

1. Clone the repository and install `uv`, Python, Node.js, and the Anna CLI.
2. Run `uv sync --extra test` in `executas\my-first-anna-app`.
3. Log in with `anna-app login --host https://anna.partners`.
4. Run `anna-app validate --strict`.
5. Start the explicit Python Executa command shown in **Run locally** (the
   default Windows Executa launcher may be blocked by local application
   control policy).
6. Paste a document and run analysis.
7. Test short and detailed summaries, action items, flashcards, and quiz.
8. Run critique/refine and ask a question that is and is not in the source.
9. Save, refresh, reload history, copy, and export Markdown.
10. Test a sampling-denied fixture and verify the honest error state.
11. Capture the listing screenshots listed in `listing\SCREENSHOTS.md`.
12. Upload the logo and screenshots through the current Anna listing workflow,
    then push the draft, cut a version, and submit it for review.
