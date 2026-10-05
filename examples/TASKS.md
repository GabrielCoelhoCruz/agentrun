---
base: HEAD
concurrency: 1
stallTimeout: 1 minute
maxDuration: 2 minutes
---
## example: Write a small example
agent: claude-code
maxTurns: 3
maxBudgetUsd: 0.25

Write example.txt with the text "example". Do not run shell commands.
