# Keep version 0.1.0 unpublished

Version 0.1.0 is intentionally unpublished on npm. The package names remain `@agentrun/core` and `agentrun`.
Use reviewed local tarballs or a reviewed source checkout. npm authentication, namespace ownership, and publication are outside the current plan.

## Prepare and verify a local installation

Use Node.js 24 and pnpm 10.29.3. Keep private reports outside the repository.

1. Record the exact merged runtime revision and the source hashes.
2. Run the project checks listed in [the release evidence](README.md#repeat-isolated-package-checks).
3. Verify hosted CI against the exact candidate revision.
4. Pack the core package before the CLI package.
5. Inspect both inventories and record the new SHA-256 hashes.
6. Install both reviewed tarballs in a new directory that you will retain.
7. Run the isolated installed checks from [the release evidence](README.md#repeat-isolated-package-checks).
8. Compare runtime hashes before reusing the retained real provider proof.
9. Record the installed executable path and the exact repeat commands in a private report.
10. Run the [example dry run](../../../examples/README.md) with the installed command.

Run these commands from the reviewed repository root to pack both packages. Set `TARBALL_DIR` to the new directory for the tarballs.

```sh
pnpm --dir packages/core pack --pack-destination "$TARBALL_DIR"
pnpm --dir packages/cli pack --pack-destination "$TARBALL_DIR"
```

Run these commands from the new installation directory after review:

```sh
npm install "$TARBALL_DIR/agentrun-core-0.1.0.tgz" "$TARBALL_DIR/agentrun-0.1.0.tgz"
npx --no-install agentrun doctor
```

The executable is `node_modules/.bin/agentrun` in that installation directory. Use its absolute path from a task repository.
For source commands, see [the root README](../../../README.md#requirements-and-installation).
The retained tarball hashes describe the original packages. A new README changes packed bytes, even when runtime source stays unchanged.
A new installation needs fresh isolated checks. Retained real proof requires matching runtime source and compatible installed dependencies.

## Superseded publication plan

The earlier plan treated npm authentication and package ownership as open questions. Registry queries returned 404 for both candidate names.
Those results did not establish ownership. The plan asked for the intended npm account, control of the `agentrun` organization, and availability of the unscoped name.
A name change would require metadata changes, new tarballs, and repeat installed checks.
The plan proposed review, commit, push, Linux CI, an ownership decision, and comparison of tarball hashes.
After explicit publication authorization, the plan proposed core publication, a registry check, CLI publication, and registry installation of both packages.
The preparation task prepared publication commands but did not execute them. Tags and release publication remained with the parent coordinator.

The decision to keep version 0.1.0 unpublished supersedes those publication steps. They are historical planning facts, not current instructions.
