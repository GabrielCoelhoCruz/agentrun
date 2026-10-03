# ADR 003: Keep provider settings explicit and deadlines honest

Status: accepted. Date: 2026-10-03. Clarifies SPEC D3, D10, D11, D13, D16, and D22.

Project settings are off by default. The CLI flag enables Claude project/local settings and Pi project settings. Pi extensions and context discovery stay disabled. This allows deliberate setup without silently enabling local hooks.

Pi rejects turn and budget limits that its SDK cannot enforce. Task duration starts cancellation across acquisition, setup, attempts, backoff, and delivery. Owned cleanup retains the concurrency permit and can outlast that duration. Git commands have a separate sixty-second limit.

Setup completion belongs to the directory that ran setup. Recreating that directory clears the completion checkpoint. Automatic retries that reuse the directory preserve the checkpoint.

The tool lists are fixed in v1. Task frontmatter does not support an `allowedTools` override.
