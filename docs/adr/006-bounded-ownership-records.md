# ADR 006: Bound ownership record reads

Run reservations and branch receipts authorize reuse of repository resources.
An unbounded read of a pipe can hold the repository lock while waiting for a writer.

Both records now use one reader with a 65,536-byte limit.
It inspects the path with `lstat` and requires a regular file within that limit.
It opens read-only with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`.
The opened handle must match the inspected device, inode, mode, size, modification time, and change time.

The reader uses one 65,537-byte buffer and handles short reads.
It rejects excess bytes and premature end of file.
After reading, it checks the handle and path again against the original metadata.
Effect closes the handle on success, failure, and interruption, including interruption during acquisition.

UTF-8 decoding is strict. JSON starts as unknown data.
Effect schemas require version 1, string identity fields, and no unknown fields.
The reader then requires the exact existing serialized identity.
Whitespace or reordered keys do not establish ownership.
Generated records must fit the same byte limit before resource creation.

Refusal uses existing ownership diagnostics without including record contents.
The repository lock and valid recovery behavior remain unchanged.
Records remain version 1. No migration or new CLI option is needed.

These checks detect observed replacement, growth, truncation, and modification during reading.
They do not prevent a process with equal host permissions from changing resources after validation.
Ownership records remain provenance for cooperating runs, not OS isolation.
