import { registerHooks } from "node:module"

const shared = `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const record = (value) => appendFileSync(process.env.AGENTRUN_SDK_FIXTURE_LOG, JSON.stringify(value) + '\\n');
const result = JSON.stringify({ verdict: 'accepted', findings: [] });
const produce = (cwd, prompt) => {
  assert.equal(readFileSync(join(cwd, 'seed'), 'utf8'), 'base\\n');
  if (prompt.includes('write-bytes')) writeFileSync(join(cwd, 'bytes.bin'), Buffer.from([0, 255, 10, 16]));
};
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@anthropic-ai/claude-agent-sdk" && specifier !== "@earendil-works/pi-coding-agent") {
      return nextResolve(specifier, context)
    }
    const original = nextResolve(specifier, context).url
    const source = specifier === "@anthropic-ai/claude-agent-sdk"
      ? `export * from ${JSON.stringify(original)};
${shared}
export function query({ prompt, options }) {
  const restricted = prompt.includes('restricted-review');
  if (restricted) {
    assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep']);
    for (const tool of ['Bash','Edit','Write','NotebookEdit','Agent','Task']) assert.ok(options.disallowedTools.includes(tool));
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.settingSources, []);
  } else assert.deepEqual(options.allowedTools, ['Read','Edit','Write','Glob','Grep','Bash']);
  assert.equal(options.permissionMode, 'dontAsk');
  record({ provider: 'claude-code', restricted, tools: options.tools ?? options.allowedTools, cwd: options.cwd, pid: process.pid });
  return Object.assign((async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'deterministic-claude' };
    produce(options.cwd, prompt);
    yield { type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0, num_turns: 1 };
  })(), { close() {} });
}
`
      : `export * from ${JSON.stringify(original)};
import { createAgentSession as createRealSession } from ${JSON.stringify(original)};
${shared}
export async function createAgentSession(options) {
  const restricted = !options.tools.includes('write');
  if (restricted) {
    assert.deepEqual(options.tools, ['read','grep','find','ls']);
    assert.equal(options.customTools, undefined);
  }
  const { session: real } = await createRealSession(options);
  if (restricted) {
    assert.deepEqual(real.getActiveToolNames().sort(), ['find','grep','ls','read']);
    real.setActiveToolsByName(['read','bash','edit','write']);
    assert.deepEqual(real.getActiveToolNames(), ['read']);
  }
  real.dispose();
  let listener;
  return { session: {
    sessionId: 'deterministic-pi',
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt(prompt) {
      assert.equal(restricted, prompt.includes('restricted-review'));
      record({ provider: 'pi', restricted, tools: options.tools, cwd: options.cwd, pid: process.pid, installedToolFilter: true });
      produce(options.cwd, prompt);
      listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: result }], usage: { input: 0, output: 0, cost: { total: 0 } }, stopReason: 'stop' } });
      listener({ type: 'agent_settled' });
    },
    async abort() {},
    dispose() {},
  } };
}
`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  },
})
