import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "agentrun" && process.env.FACTORY_FIXTURE_EXECUTOR_INDEX !== undefined) {
      return nextResolve(process.env.FACTORY_FIXTURE_EXECUTOR_INDEX, context)
    }
    if (
      specifier === "@agentrun/core" && process.env.FACTORY_FIXTURE_MODE === "unknown-cost"
      && process.argv.some((arg) => arg.startsWith("agentrun-worker-"))
    ) {
      const original = nextResolve(specifier, context).url
      const effect = nextResolve("effect", context).url
      const source = `
export * from ${JSON.stringify(original)};
import { ClaudeCode as real } from ${JSON.stringify(original)};
import { Stream } from ${JSON.stringify(effect)};
export const ClaudeCode = { ...real, adapter: { ...real.adapter, run(input) {
  return real.adapter.run(input).pipe(Stream.map(event => {
    if (event._tag !== 'Completed' && event._tag !== 'Usage') return event;
    const { costUsd, ...unknownCost } = event;
    return unknownCost;
  }));
} } };
`
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    if (specifier !== "@anthropic-ai/claude-agent-sdk") return nextResolve(specifier, context)
    const original = nextResolve(specifier, context).url
    const source = `
export * from ${JSON.stringify(original)};
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const record = (value) => appendFileSync(process.env.FACTORY_FIXTURE_LOG, JSON.stringify(value) + '\\n');
export function query({ prompt, options }) {
  const task = JSON.parse(prompt);
  const mode = process.env.FACTORY_FIXTURE_MODE ?? 'happy';
  const review = task.stage === 'review';
  if (review) {
    assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    for (const name of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task']) assert.ok(options.disallowedTools.includes(name));
  }
  assert.equal(options.permissionMode, 'dontAsk');
  const prior = existsSync(process.env.FACTORY_FIXTURE_LOG)
    ? readFileSync(process.env.FACTORY_FIXTURE_LOG, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
  record({ kind: 'provider', stage: task.stage, attemptId: task.attemptId, inputSha: task.inputSha, pid: process.pid, cwd: options.cwd, review, maxBudgetUsd: options.maxBudgetUsd });
  return Object.assign((async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'local-fixture' };
    if (!review) {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fixture-write', name: 'Write', input: {} }] } };
      if (mode === 'cancel-agent' || mode === 'crash-tools') {
        writeFileSync(join(options.cwd, 'partial.txt'), 'partial effect\\n');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        record({ kind: 'child', pid: child.pid, parent: process.pid });
        if (mode === 'crash-tools') process.kill(Number(process.env.FACTORY_FIXTURE_COORDINATOR), 'SIGKILL');
        await new Promise(() => {});
      }
      const firstIncorrect = ['correct', 'hang-correct'].includes(mode) && task.stage === 'implement';
      if (mode === 'hang-correct' && task.stage === 'correct' && !prior.some((r) => r.stage === 'correct')) {
        writeFileSync(join(options.cwd, 'partial.txt'), 'partial correction effect\\n');
        setInterval(() => record({ kind: 'heartbeat', pid: process.pid, at: Date.now() }), 100);
        await new Promise(() => {});
      }
      if (!['no-change', 'wrong-output'].includes(mode)) {
        if (firstIncorrect || mode === 'correction-limit') {
          writeFileSync(join(options.cwd, 'attempt.txt'), task.attemptId + '\\n');
        } else {
          copyFileSync(process.env.FACTORY_FIXTURE_DURABLE, join(options.cwd, 'server.ts'));
          if (task.stage === 'correct') {
            const file = join(options.cwd, 'server.ts');
            writeFileSync(file, readFileSync(file, 'utf8').replace('not found', 'note not found'));
          }
        }
      }
      if (mode === 'candidate-attributes') {
        writeFileSync(join(options.cwd, '.gitattributes'), 'candidate-only.txt export-ignore\\nserver.ts export-subst\\n');
        writeFileSync(join(options.cwd, 'candidate-only.txt'), 'checked candidate bytes\\n');
        const server = join(options.cwd, 'server.ts');
        writeFileSync(server, readFileSync(server, 'utf8') + '\\n// $Format:%H$\\n');
      }
      if (mode === 'wrong-output') writeFileSync(join(options.cwd, 'unrelated.txt'), 'The agent claims success.\\n');
      if (mode === 'wrong-ancestry') {
        const git = (args) => { const r = spawnSync('git', args, { cwd: options.cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
        git(['add', '-A']);
        const tree = git(['write-tree']);
        const commit = git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit-tree',tree,'-m','unrelated root']);
        git(['reset','--hard',commit]);
      }
      if (mode === 'linked-checks') {
        renameSync(join(options.cwd, 'checks'), join(options.cwd, 'old-checks'));
        symlinkSync(process.env.FACTORY_FIXTURE_ORIGINAL_CHECKS, join(options.cwd, 'checks'), 'dir');
      }
      if (mode === 'changed-check') writeFileSync(join(options.cwd, 'checks/restart.mjs'), 'process.exit(0)\\n');
    }
    let result = 'Implementation complete';
    if (review) {
      let verdict = 'accepted';
      let findings = [];
      if (mode === 'review-revision' && !prior.some((r) => r.stage === 'review')) {
        verdict = 'revision-needed';
        findings = [{ file: 'server.ts', line: 6, severity: 'medium', message: 'Use the explicit note error message.' }];
      }
      if (mode === 'outside-diff') {
        verdict = 'revision-needed';
        findings = [{ file: 'missing.ts', line: 1, severity: 'high', message: 'Invalid location.' }];
      }
      if (mode === 'human-review') verdict = 'human-needed';
      if (mode === 'changed-review') writeFileSync(join(options.cwd, 'review-write.txt'), 'unexpected write\\n');
      result = JSON.stringify({ version: 1, candidate: mode === 'wrong-review-candidate' ? '0'.repeat(40) : task.inputSha, profileHash: task.profileHash, verdict, findings });
      if (mode === 'malformed-review') result = 'accepted';
    }
    yield { type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0, num_turns: 1 };
  })(), { close() {} });
}
`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  },
})
