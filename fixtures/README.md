# Ingestion fixtures

These fixtures exercise the offline ingestion boundary. Text-like formats are
processed locally. Binary formats that require unavailable parsers are tested
as explicit unsupported results, never as silent failures.
