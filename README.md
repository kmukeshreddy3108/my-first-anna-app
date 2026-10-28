# StudyLens AI

StudyLens AI is an AI Study & Document Analyst for turning pasted notes,
articles, meeting transcripts, and reports into structured, verifiable study
outputs. It uses a multi-step workflow: analyze the source, generate an
output, critique the draft against the source, and answer grounded follow-up
questions. AI results are labelled; when sampling is unavailable, the app
returns a clear structured error instead of pretending.

## Run locally

Prerequisites: Node.js, `uv`, Python 3.10+, and the Anna CLI.

```powershell
cd C:\Users\kathi\my-first-anna-app
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
