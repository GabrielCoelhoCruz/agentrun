import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const proof = fileURLToPath(new URL("../scripts/installed-e2e.mjs", import.meta.url))
const evaluate = (body: string) =>
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
   import { verifyHashes, verifyBindings, verifyJourneys, runCommand } from ${
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
