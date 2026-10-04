`success.jsonl` contains selected fields from a real Pi SDK 1.0.0 run.
The run used one write tool call and two assistant responses.

The fixture retains event order, stop reasons, token counts, and costs.
Tool IDs are synthetic. Paths, file contents, result text, and assistant text are normalized.
Unused fields, message IDs, model metadata, and raw tool diagnostics are removed.
The original records remain in private temporary evidence outside this repository.

Failure and retry cases use synthetic events in `Pi.test.ts`.
