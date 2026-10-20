import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { stopProcessGroup } from "../src/ProcessGroup.js"

const token = "e".repeat(32)
const root = 900001
const child = 900002
const grandchild = 900003
const started = "Thu Jan  1 00:00:00 1970"
const row = (pid: number, parent: number, group = pid, state = "S", start = started) =>
  `${pid} ${parent} ${group} ${state} ${start} node agentrun-worker-${token}`
const leader = row(root, 1)
const nested = row(child, root)
const orphan = row(child, 1)
const inherited = row(grandchild, 1, child)
const foreign = row(900004, 1)
const probes = [
  { name: "R1 initial detached child", snapshots: [[leader, nested], [orphan]], expected: "Failure" },
  { name: "R2 late child", snapshots: [[leader], [leader, nested], [orphan]], expected: "Failure" },
  {
    name: "R2 late detached grandchild",
    snapshots: [[leader, nested], [nested, row(grandchild, child)], [row(grandchild, 1)]],
    expected: "Failure",
  },
  { name: "R3 inherited known group", snapshots: [[leader, nested], [inherited]], expected: "Failure" },
  {
    name: "late inherited known group",
    snapshots: [[leader], [leader, nested], [inherited]],
    expected: "Failure",
  },
  { name: "moved initial child", snapshots: [[leader, nested], [row(child, 1, 900005)]], expected: "Failure" },
  {
    name: "late child forks again",
    snapshots: [[leader], [leader, nested], [nested, row(grandchild, child)], [row(grandchild, 1)]],
    expected: "Failure",
  },
  {
    name: "different start in retained group",
    snapshots: [[leader, nested], [row(child, 1, child, "S", "Fri Jan  2 00:00:00 1970")]],
    expected: "Failure",
  },
  {
    name: "different start in another group",
    snapshots: [[leader, nested], [row(child, 1, 900005, "S", "Fri Jan  2 00:00:00 1970")]],
    expected: "Success",
  },
  {
    name: "same start in another group",
    snapshots: [[leader, nested], [row(child, 1, 900005)]],
    expected: "Failure",
  },
  {
    name: "reused PID cannot become a parent",
    snapshots: [[leader, nested], [row(child, 1, 900005, "S", "Fri Jan  2 00:00:00 1970"), row(grandchild, child)]],
    expected: "Success",
  },
  { name: "external parent in root group", snapshots: [[leader, row(child, 1, root)], [orphan]], expected: "Failure" },
  {
    name: "late child joins a foreign group",
    snapshots: [[leader], [leader, row(child, root, 900004)], [row(child, 1, 900004)]],
    expected: "Failure",
  },
  { name: "descendants exit", snapshots: [[leader, nested], []], expected: "Success" },
  { name: "late descendant exits", snapshots: [[leader], [leader, nested], []], expected: "Success" },
  { name: "zombie descendant", snapshots: [[leader, nested], [row(child, 1, child, "Z")]], expected: "Success" },
  { name: "unrelated process", snapshots: [[leader], [foreign]], expected: "Success" },
  // #50: a detached fork that loses ancestry before observation remains a shared limitation.
  { name: "issue 50 unobserved detached fork", snapshots: [[leader], [row(grandchild, 1)]], expected: "Success" },
] as const

test.each(probes)("both ownership paths make the same exit decision: $name", async ({ name, snapshots, expected }) => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-exit-parity-"))
  const original = process.env.PATH
  const decisions: Array<string> = []
  try {
    for (const maySignal of [true, false]) {
      const tables = snapshots.map((snapshot) =>
        [...snapshot, ...(snapshot.some((line) => line === foreign) ? [] : [foreign])].join("\n")
      )
      if (!maySignal) tables[0] = tables[0]!.replace(leader, leader.replace(`node agentrun-worker-${token}`, "(node)"))
      writeFileSync(join(directory, "poll"), "0")
      writeFileSync(
        join(directory, "ps"),
        `#!${process.execPath}
const {readFileSync,renameSync,writeFileSync}=require('node:fs');
const dir=${JSON.stringify(directory)},tables=${JSON.stringify(tables)};
let poll=Number(readFileSync(dir+'/poll','utf8'));
if(!process.argv.some(arg=>arg.includes('command='))){writeFileSync(dir+'/poll.'+process.pid,String(++poll));renameSync(dir+'/poll.'+process.pid,dir+'/poll')}
process.stdout.write(tables[Math.min(poll,tables.length-1)]+'\\n');
`,
        { mode: 0o755 },
      )
      const signals: Array<{ pid: number; signal: string }> = []
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal !== 0) {
          signals.push({ pid, signal: String(signal) })
          return true
        }
        const poll = Number(readFileSync(join(directory, "poll"), "utf8"))
        const current = snapshots[Math.min(poll, snapshots.length - 1)]!
        if (current.some((line) => Number(line.split(" ")[2]) === -pid)) return true
        throw Object.assign(new Error("No such process"), { code: "ESRCH" })
      })
      try {
        process.env.PATH = `${directory}:${original}`
        const result = await Effect.runPromiseExit(stopProcessGroup(root, token))
        decisions.push(result._tag)
        if (!maySignal) expect(signals).toEqual([])
        expect(signals.some(({ pid }) => pid === -900004)).toBe(false)
        const polls = Number(readFileSync(join(directory, "poll"), "utf8"))
        if (process.env.AGENTRUN_TEST_EVIDENCE) {
          writeFileSync(
            join(process.env.AGENTRUN_TEST_EVIDENCE, `parity-${name}-${maySignal}.json`),
            JSON.stringify({ name, maySignal, result, polls, signals, snapshots }, null, 2),
          )
        }
        if (expected === "Failure") expect(polls, JSON.stringify(result)).toBe(80)
      } finally {
        spy.mockRestore()
      }
    }
    expect(decisions).toEqual([expected, expected])
  } finally {
    process.env.PATH = original
    rmSync(directory, { recursive: true })
  }
}, 30000)
