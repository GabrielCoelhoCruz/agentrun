import { Effect } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { expect, test, vi } from "vitest"
import { stopProcessGroup } from "../src/ProcessGroup.js"

const token = "d".repeat(32)

test.each(
  [
    { kind: "worker", depth: 1, outcome: "live" },
    { kind: "factory", depth: 1, outcome: "live" },
    { kind: "worker", depth: 2, outcome: "live" },
    { kind: "worker", depth: 2, outcome: "forks again" },
    { kind: "worker", depth: 2, outcome: "exits" },
    { kind: "worker", depth: 2, outcome: "reused parent" },
  ] as const,
)("unverified cleanup follows late descendants ($kind, depth $depth, $outcome)", async ({
  kind,
  depth,
  outcome,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-late-descendants-"))
  const actor = join(directory, "actor.cjs")
  writeFileSync(
    actor,
    `
const {spawn}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const dir=${JSON.stringify(directory)}, depth=Number(process.argv[2]);
let forked=false;
process.on('message',()=>{process.title='agentrun-exiting';process.send('obscured')});
setInterval(()=>{
 if(existsSync(dir+'/exit-'+depth))process.exit(0);
 if(!forked&&existsSync(dir+'/fork-'+depth)){
  forked=true;
  const child=spawn(process.execPath,[__filename,String(depth+1),'agentrun-late-${token}'],{detached:true,stdio:'ignore'});
  child.unref();
 }
},5);
writeFileSync(dir+'/ready-'+depth,JSON.stringify({pid:process.pid,parent:process.ppid}));
process.send?.('ready');
`,
  )
  const leader = spawn(process.execPath, [actor, "0", `agentrun-${kind}-${token}`], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  const done = once(leader, "close")
  const original = process.env.PATH
  const realKill = process.kill.bind(process)
  const signals: Array<{ pid: number; signal: string }> = []
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== 0) signals.push({ pid, signal: String(signal) })
    return realKill(pid, signal)
  })
  try {
    await once(leader, "message", { signal: AbortSignal.timeout(5000) })
    if (depth === 2) {
      writeFileSync(join(directory, "fork-0"), "go")
      const deadline = Date.now() + 5000
      while (!existsSync(join(directory, "ready-1")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(existsSync(join(directory, "ready-1"))).toBe(true)
    }
    leader.send("obscure")
    await once(leader, "message", { signal: AbortSignal.timeout(5000) })
    writeFileSync(
      join(directory, "ps"),
      `#!${process.execPath}
const {execFileSync}=require('node:child_process');
const {existsSync,readFileSync,writeFileSync}=require('node:fs');
const dir=${JSON.stringify(directory)}, depth=${depth}, outcome=${JSON.stringify(outcome)};
const command=process.argv.some(arg=>arg.includes('command='));
const polls=command?0:(existsSync(dir+'/polls')?Number(readFileSync(dir+'/polls','utf8')):0)+1;
if(!command){
 writeFileSync(dir+'/polls',String(polls));
 const target=outcome==='forks again'&&polls>1?depth+1:depth;
 const deadline=Date.now()+3000;
 while(!existsSync(dir+'/ready-'+target)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
}
if(!command&&outcome==='reused parent'){
 writeFileSync(dir+'/exit-0','exit');
 const leader=JSON.parse(readFileSync(dir+'/ready-0','utf8')).pid;
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){
  const rows=execFileSync('/bin/ps',['-axo','pid=,stat='],{encoding:'utf8'}).split('\\n');
  if(!rows.some(line=>Number(line.trim().split(/\\s+/)[0])===leader))break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
 }
}
let output=execFileSync('/bin/ps',process.argv.slice(2),{encoding:'utf8'});
if(!command&&outcome==='reused parent'){
 const parent=JSON.parse(readFileSync(dir+'/ready-1','utf8')).pid;
 output=output.split('\\n').map(line=>Number(line.trim().split(/\\s+/)[0])===parent
  ?line.replace(/\\w{3} +\\w{3} +\\d+ +\\d{2}:\\d{2}:\\d{2} +\\d{4}/,'Thu Jan  1 00:00:00 1970'):line).join('\\n');
}
if(command){
 writeFileSync(dir+'/initial.txt',output);
 writeFileSync(dir+'/fork-'+(depth-1),'go');
}else if(polls===1){
 writeFileSync(dir+'/first-poll.txt',output);
 for(let n=0;n<depth;n++)writeFileSync(dir+'/exit-'+n,'exit');
 if(outcome==='exits')writeFileSync(dir+'/exit-'+depth,'exit');
 if(outcome==='forks again')writeFileSync(dir+'/fork-'+depth,'go');
}else if(polls===2&&outcome==='forks again'){
 writeFileSync(dir+'/second-poll.txt',output);
 writeFileSync(dir+'/exit-'+depth,'exit');
}
process.stdout.write(output);
`,
      { mode: 0o755 },
    )
    process.env.PATH = `${directory}:${original}`
    const result = await Effect.runPromiseExit(stopProcessGroup(leader.pid!, token, kind))
    await done
    const nested: { pid: number; parent: number } = JSON.parse(readFileSync(join(directory, `ready-${depth}`), "utf8"))
    const initial = readFileSync(join(directory, "initial.txt"), "utf8")
    const firstPoll = readFileSync(join(directory, "first-poll.txt"), "utf8")
    if (outcome === "reused parent") {
      expect(firstPoll.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === leader.pid)).toBe(false)
    }
    const rows = (text: string) => text.split("\n").map((line) => line.trim().split(/\s+/).slice(0, 3).map(Number))
    expect(rows(initial).some(([pid]) => pid === nested.pid)).toBe(false)
    expect(rows(firstPoll)).toContainEqual([nested.pid, nested.parent, nested.pid])
    expect(signals).toEqual([])
    if (outcome === "forks again") {
      const later: { pid: number; parent: number } = JSON.parse(
        readFileSync(join(directory, `ready-${depth + 1}`), "utf8"),
      )
      const secondPoll = readFileSync(join(directory, "second-poll.txt"), "utf8")
      expect(rows(secondPoll)).toContainEqual([later.pid, nested.pid, later.pid])
      expect(rows(secondPoll).some(([pid]) => pid === leader.pid)).toBe(false)
      expect(() => realKill(later.pid, 0)).not.toThrow()
    } else if (outcome === "live") {
      expect(() => realKill(nested.pid, 0)).not.toThrow()
    }
    const polls = Number(readFileSync(join(directory, "polls"), "utf8"))
    if (process.env.AGENTRUN_TEST_EVIDENCE) {
      writeFileSync(
        join(process.env.AGENTRUN_TEST_EVIDENCE, `late-${kind}-${depth}-${outcome}.json`),
        JSON.stringify({ result: inspect(result, { depth: 8 }), signals, polls, initial, firstPoll }, null, 2),
      )
    }
    expect(result._tag, inspect(result, { depth: 8 })).toBe(
      (outcome === "exits" || outcome === "reused parent") ? "Success" : "Failure",
    )
    if (outcome === "live" || outcome === "forks again") expect(polls).toBe(80)
  } finally {
    spy.mockRestore()
    process.env.PATH = original
    for (let n = 0; n <= depth + 1; n++) writeFileSync(join(directory, `exit-${n}`), "exit")
    // Let the actors observe their exit files before checking for survivors.
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (let n = 0; n <= depth + 1; n++) {
      const ready = join(directory, `ready-${n}`)
      if (!existsSync(ready)) continue
      const { pid }: { pid: number } = JSON.parse(readFileSync(ready, "utf8"))
      const row = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid=,stat=,command=", "-ww"], { encoding: "utf8" })
      if (
        row.stdout.trim().split(/\s+/)[0] === String(pid)
        && !/[ZE]/.test(row.stdout.trim().split(/\s+/)[1]!)
        && row.stdout.includes(n === 0 ? actor : `agentrun-late-${token}`)
      ) {
        try {
          realKill(-pid, "SIGKILL")
        } catch (cause) {
          expect(cause).toMatchObject({ code: expect.stringMatching(/^(ESRCH|EPERM)$/) })
          const state = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
          expect(state.stdout.trim() === "" || /[ZE]/.test(state.stdout)).toBe(true)
        }
      }
    }
    await done
    rmSync(directory, { recursive: true })
  }
}, 20000)
