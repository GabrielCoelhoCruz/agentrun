# Release plan for the parent

Both names remain candidates: `@agentrun/core` and `agentrun`. npm is not authenticated here. A registry 404 does not establish permission to publish. Confirm the intended npm account, control of the `agentrun` organization, and availability of the unscoped name. If a name must change, update metadata and repeat packing and installed checks before release.

1. Review the uncommitted candidate and its private report.
2. Commit the reviewed changes without attribution trailers.
3. Push the draft release PR and verify Linux checks on its exact commit.
4. Confirm npm ownership and the final publication decision.
5. Compare tarball hashes with the reviewed inventory.
6. Publish the core tarball first.
7. Verify `@agentrun/core@0.1.0` is available from the registry.
8. Publish the CLI tarball.
9. Verify registry installation of both packages.

After explicit authorization, use the reviewed tarballs in this order:

```sh
npm publish "$TARBALL_DIR/agentrun-core-0.1.0.tgz" --access public
npm view @agentrun/core@0.1.0 version dist.integrity --json
npm publish "$TARBALL_DIR/agentrun-0.1.0.tgz" --access public
npm view agentrun@0.1.0 version dist.integrity --json
```

These commands were prepared, not executed. Tags and release publication remain with the parent. README registry installation instructions can be updated after publication is confirmed.
