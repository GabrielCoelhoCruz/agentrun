import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const proof = fileURLToPath(new URL("../scripts/installed-e2e.mjs", import.meta.url))
const evaluate = (body: string) =>
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
   import { verifyHashes, verifyBindings, verifyJourneys, runCommand, runConcurrently, mergeJourneyResults, candidateIdentity, lockedDependencyOverrides } from ${
      JSON.stringify(new URL("../scripts/installed-e2e.mjs", import.meta.url).href)
    };
   ${body}`,
  ], { encoding: "utf8" })

test("installed proof refuses changed package bytes", () => {
  expect(evaluate(`
    import { mkdtempSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    const file = join(mkdtempSync(join(tmpdir(), 'installed-hash-')), 'module.mjs');
    writeFileSync(file, 'candidate');
    const expected = { [file]: createHash('sha256').update('candidate').digest('hex') };
    verifyHashes(expected);
    writeFileSync(file, 'changed');
    assert.throws(() => verifyHashes(expected), /hash/i);
  `)).toBe("")
})

test("installed proof refuses checkout resolution and split core instances", () => {
  expect(evaluate(`
    verifyBindings('/consumer', ['/consumer/factory.mjs'], ['/consumer/core.mjs', '/consumer/core.mjs']);
    assert.throws(() => verifyBindings('/consumer', ['/checkout/factory.mjs'], ['/consumer/core.mjs']), /consumer/i);
    assert.throws(() => verifyBindings('/consumer', ['/consumer-other/factory.mjs'], ['/consumer/core.mjs']), /consumer/i);
    assert.throws(() => verifyBindings('/consumer', ['/consumer/factory.mjs'], ['/consumer/core.mjs', '/consumer/other-core.mjs']), /core/i);
    assert.throws(() => verifyBindings('/consumer', [], []), /binding/i);
  `)).toBe("")
})

test("installed proof refuses failed, empty and incomplete journeys", () => {
  expect(evaluate(`
    const required = ['happy', 'cancel-agent'];
    const outcomes = required.map(name => ({ name, outcome: 'pass' }));
    verifyJourneys(outcomes, required);
    assert.throws(() => verifyJourneys([], required), /journey/i);
    assert.throws(() => verifyJourneys(outcomes.slice(0, 1), required), /journey/i);
    assert.throws(() => verifyJourneys([{ name: 'happy', outcome: 'fail' }, outcomes[1]], required), /journey/i);
    assert.throws(() => verifyJourneys([outcomes[0], outcomes[0]], required), /journey/i);
    assert.throws(() => verifyJourneys([...outcomes, { name: 'invented', outcome: 'pass' }], required), /journey/i);
  `)).toBe("")
})

test("installed proof preserves native command failure and refuses success", () => {
  expect(evaluate(`
    import { mkdtempSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = mkdtempSync(join(tmpdir(), 'installed-command-'));
    assert.throws(() => runCommand(directory, 'failed', process.execPath, ['-e', 'console.error("cause-marker"); process.exit(23)'], directory), /command/i);
    const receipt = JSON.parse(readFileSync(join(directory, 'failed.json'), 'utf8'));
    assert.equal(receipt.status, 23);
    assert.match(receipt.stderr, /cause-marker/);
    assert.equal(receipt.executable, process.execPath);
  `)).toBe("")
})

test("installed proof refuses an existing evidence directory", () => {
  const result = spawnSync(process.execPath, [proof, fileURLToPath(new URL(".", import.meta.url))], {
    encoding: "utf8",
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/EEXIST/)
})

test("installed proof keeps parent-specific transitive versions from the source lock", () => {
  expect(evaluate(`
    const snapshots = {
      '@earendil-works/pi-coding-agent@1.0.0(peer@2.0.0)': {
        dependencies: { '@earendil-works/pi-codemode': '1.0.0', shared: '2.0.0(peer@2.0.0)' },
        optionalDependencies: { native: '3.0.0' },
      },
      'other@1.0.0': { dependencies: { shared: '1.0.0' } },
      'leaf@1.0.0': {},
    };
    const overrides = lockedDependencyOverrides(snapshots);
    assert.equal(overrides['@earendil-works/pi-coding-agent@1.0.0>@earendil-works/pi-codemode'], '1.0.0');
    assert.equal(overrides['@earendil-works/pi-coding-agent@1.0.0>shared'], '2.0.0');
    assert.equal(overrides['other@1.0.0>shared'], '1.0.0');
    assert.equal(overrides['@earendil-works/pi-coding-agent@1.0.0>native'], '3.0.0');
    assert.throws(() => lockedDependencyOverrides({
      'parent@1.0.0(peer@1.0.0)': { dependencies: { child: '1.0.0' } },
      'parent@1.0.0(peer@2.0.0)': { dependencies: { child: '2.0.0' } },
    }), /conflicting/i);
  `)).toBe("")
})

test("installed proof records the tested merge commit as the candidate and the pull request head apart", () => {
  expect(evaluate(`
    const merge = 'c'.repeat(40);
    const parents = ['a'.repeat(40), 'b'.repeat(40)];
    assert.deepEqual(candidateIdentity({ head: merge, parents, pullRequestHead: 'b'.repeat(40), pullRequestBase: 'd'.repeat(40) }), {
      candidate: { head: merge, parents },
      pullRequest: { head: 'b'.repeat(40), base: 'd'.repeat(40) },
    });
    assert.deepEqual(candidateIdentity({ head: merge, parents: ['a'.repeat(40)] }), {
      candidate: { head: merge, parents: ['a'.repeat(40)] },
      pullRequest: null,
    });
    assert.deepEqual(candidateIdentity({ head: merge, parents, pullRequestHead: merge }).candidate.head, merge);
    assert.throws(() => candidateIdentity({ head: merge, parents, pullRequestHead: 'e'.repeat(40) }), /pull request head/i);
  `)).toBe("")
})

test("installed proof runs journeys concurrently up to the limit and keeps every receipt", async () => {
  expect(evaluate(`
    import { mkdtempSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = mkdtempSync(join(tmpdir(), 'installed-pool-'));
    const sleeper = (name) => ({ name, executable: process.execPath, argv: ['-e', 'setTimeout(() => console.log(process.argv[1]), 400)', name], cwd: directory });
    const names = ['one', 'two', 'three', 'four', 'five'];
    const outputs = await runConcurrently(directory, names.map(sleeper), 2);
    assert.deepEqual(outputs.map((output) => output.trim()), names);
    const spans = names.map((name) => JSON.parse(readFileSync(join(directory, name + '.json'), 'utf8')))
      .map((receipt) => [Date.parse(receipt.started), Date.parse(receipt.ended)]);
    const overlap = Math.max(...spans.map(([start]) => spans.filter(([s, e]) => s <= start && start < e).length));
    assert.equal(overlap, 2);
  `)).toBe("")
})

test("installed proof fails after running journeys settle and starts no queued journey", () => {
  expect(evaluate(`
    import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = mkdtempSync(join(tmpdir(), 'installed-pool-fail-'));
    const marker = join(directory, 'slow-finished');
    const tasks = [
      { name: 'failed', executable: process.execPath, argv: ['-e', 'console.error("cause-marker"); process.exit(23)'], cwd: directory },
      { name: 'slow', executable: process.execPath, argv: ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "done"), 500)', marker], cwd: directory },
      { name: 'queued', executable: process.execPath, argv: ['-e', ''], cwd: directory },
    ];
    await assert.rejects(runConcurrently(directory, tasks, 2), /command failed: failed/i);
    assert.equal(readFileSync(marker, 'utf8'), 'done');
    const receipt = JSON.parse(readFileSync(join(directory, 'failed.json'), 'utf8'));
    assert.equal(receipt.status, 23);
    assert.match(receipt.stderr, /cause-marker/);
    assert.equal(existsSync(join(directory, 'queued.json')), false);
  `)).toBe("")
})

test("installed proof refuses journey results from a different CLI build", () => {
  expect(evaluate(`
    const part = (name, cliSha256) => ({ cli: '/consumer/bin.mjs', cliSha256, paidProviderCalls: 0, outcomes: [{ name, outcome: 'pass' }] });
    assert.deepEqual(mergeJourneyResults([part('happy', 'a'), part('correct', 'a')]), {
      cli: '/consumer/bin.mjs', cliSha256: 'a', paidProviderCalls: 0,
      outcomes: [{ name: 'happy', outcome: 'pass' }, { name: 'correct', outcome: 'pass' }],
    });
    assert.throws(() => mergeJourneyResults([part('happy', 'a'), part('correct', 'b')]), /cli/i);
    assert.throws(() => mergeJourneyResults([part('happy', 'a'), { ...part('correct', 'a'), paidProviderCalls: 1 }]), /paid/i);
  `)).toBe("")
})
