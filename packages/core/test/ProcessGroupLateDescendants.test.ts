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

const probes = (
  [
    { kind: "worker", depth: 1, outcome: "live" },
    { kind: "factory", depth: 1, outcome: "live" },
    { kind: "worker", depth: 2, outcome: "live" },
    { kind: "worker", depth: 2, outcome: "forks again" },
    { kind: "worker", depth: 2, outcome: "exits" },
    { kind: "worker", depth: 2, outcome: "reused parent" },
  ] as const
).flatMap((probe) => [false, true].map((verified) => ({ ...probe, verified })))

test.each([
  ...probes,
  ...["escalation fork", "reused leader", "moved group"].map((outcome) => ({
    kind: "worker" as const,
    depth: 1 as const,
    outcome,
    verified: true,
  })),
  { kind: "factory" as const, depth: 1 as const, outcome: "escalation fork", verified: true },
  // Known limit: ancestry is lost when the parent exits before the next snapshot.
  ...[false, true].map((verified) => ({
    kind: "worker" as const,
    depth: 1 as const,
    outcome: "between snapshots",
    verified,
  })),
])("cleanup follows late descendants (verified $verified, $kind, depth $depth, $outcome)", async ({
  kind,
  depth,
  outcome,
  verified,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-late-descendants-"))
  const actor = join(directory, "actor.cjs")
  const mover = join(directory, "mover.py")
  if (outcome === "moved group") {
    writeFileSync(
      mover,
      `
import json, os, signal, sys, time
directory = sys.argv[1]
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(directory + '/ready-1', 'w') as ready:
    json.dump({'pid': os.getpid(), 'parent': os.getppid()}, ready)
while not os.path.exists(directory + '/exit-1'):
    if os.path.exists(directory + '/move') and os.getpgrp() != os.getpid():
        os.setpgid(0, 0)
    time.sleep(0.005)
`,
    )
  }
  writeFileSync(
    actor,
    `
const {spawn}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const dir=${JSON.stringify(directory)}, depth=Number(process.argv[2]);
let forked=false;
process.on('SIGTERM',()=>{});
process.on('message',()=>{process.title='agentrun-exiting';process.send('obscured')});
setInterval(()=>{
 if(existsSync(dir+'/exit-'+depth))process.exit(0);
 if(!forked&&existsSync(dir+'/fork-'+depth)){
  forked=true;
  const child=${
      outcome === "moved group"
        ? `spawn('python3',[${JSON.stringify(mover)},dir,'agentrun-late-${token}'],{stdio:['ignore','ignore','pipe']})`
        : `spawn(process.execPath,[__filename,String(depth+1),'agentrun-late-${token}'],{detached:true,stdio:'ignore'})`
    };
  child.on('error',cause=>writeFileSync(dir+'/actor-error.txt',String(cause)));
  child.stderr?.on('data',data=>writeFileSync(dir+'/actor-error.txt',data));
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
    const result = realKill(pid, signal)
    // This child inherits the group, so fork after the group's initial SIGTERM.
    if (outcome === "moved group" && pid === -leader.pid! && signal === "SIGTERM") {
      writeFileSync(join(directory, "fork-0"), "go")
    }
    return result
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
    if (!verified) {
      leader.send("obscure")
      await once(leader, "message", { signal: AbortSignal.timeout(5000) })
    }
    writeFileSync(
      join(directory, "ps"),
      `#!${process.execPath}
const {execFileSync}=require('node:child_process');
const {existsSync,readFileSync,writeFileSync}=require('node:fs');
const dir=${JSON.stringify(directory)}, depth=${depth}, outcome=${JSON.stringify(outcome)};
const command=process.argv.some(arg=>arg.includes('command='));
const commands=command?(existsSync(dir+'/commands')?Number(readFileSync(dir+'/commands','utf8')):0)+1:0;
if(command)writeFileSync(dir+'/commands',String(commands));
const polls=command?0:(existsSync(dir+'/polls')?Number(readFileSync(dir+'/polls','utf8')):0)+1;
if(!command)writeFileSync(dir+'/polls',String(polls));
if(command&&commands===2&&outcome==='escalation fork')writeFileSync(dir+'/fork-0','go');
if((!command&&outcome!=='escalation fork'&&outcome!=='reused leader')||(command&&commands===2&&outcome==='escalation fork')){
 const target=outcome==='forks again'&&polls>1?depth+1:depth;
 const deadline=Date.now()+3000;
 while(!existsSync(dir+'/ready-'+target)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
}
if(!command&&outcome==='between snapshots'){
 writeFileSync(dir+'/exit-0','exit');
 const child=JSON.parse(readFileSync(dir+'/ready-1','utf8')).pid;
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){
  const table=execFileSync('/bin/ps',['-p',String(child),'-o','ppid='],{encoding:'utf8'});
  if(table.trim()==='1')break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
 }
}
if((!command||commands>1)&&outcome==='reused parent'){
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
if((!command||commands>1)&&outcome==='reused leader'){
 const leader=JSON.parse(readFileSync(dir+'/ready-0','utf8')).pid;
 output=output.split('\\n').map(line=>Number(line.trim().split(/\\s+/)[0])===leader
  ?line.replace(/\\w{3} +\\w{3} +\\d+ +\\d{2}:\\d{2}:\\d{2} +\\d{4}/,'Thu Jan  1 00:00:00 1970'):line).join('\\n');
}
if(!command&&polls>1&&outcome==='moved group'){
 const child=JSON.parse(readFileSync(dir+'/ready-1','utf8')).pid;
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){
  const group=execFileSync('/bin/ps',['-p',String(child),'-o','pgid='],{encoding:'utf8'});
  if(Number(group.trim())===child)break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
 }
 output=execFileSync('/bin/ps',process.argv.slice(2),{encoding:'utf8'});
 writeFileSync(dir+'/moved.txt',output);
}
if((!command||commands>1)&&outcome==='reused parent'){
 const parent=JSON.parse(readFileSync(dir+'/ready-1','utf8')).pid;
 output=output.split('\\n').map(line=>Number(line.trim().split(/\\s+/)[0])===parent
  ?line.replace(/\\w{3} +\\w{3} +\\d+ +\\d{2}:\\d{2}:\\d{2} +\\d{4}/,'Thu Jan  1 00:00:00 1970'):line).join('\\n');
}
if(command&&commands===1){
 writeFileSync(dir+'/initial.txt',output);
 if(!['escalation fork','reused leader','moved group'].includes(outcome))writeFileSync(dir+'/fork-'+(depth-1),'go');
}else if(command&&commands===2&&outcome==='escalation fork'){
 writeFileSync(dir+'/escalation.txt',output);
 writeFileSync(dir+'/exit-0','exit');
}else if(!command&&polls===1){
 writeFileSync(dir+'/first-poll.txt',output);
 if(outcome!=='escalation fork'&&outcome!=='reused leader')for(let n=0;n<depth;n++)writeFileSync(dir+'/exit-'+n,'exit');
 if(outcome==='exits')writeFileSync(dir+'/exit-'+depth,'exit');
 if(outcome==='forks again')writeFileSync(dir+'/fork-'+depth,'go');
 if(outcome==='moved group')writeFileSync(dir+'/move','go');
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
    if (outcome !== "reused leader") await done
    const actorError = join(directory, "actor-error.txt")
    expect(existsSync(actorError) ? readFileSync(actorError, "utf8") : "").toBe("")
    const nested: { pid: number; parent: number } | undefined = outcome === "reused leader"
      ? undefined
      : JSON.parse(readFileSync(join(directory, `ready-${depth}`), "utf8"))
    const initial = readFileSync(join(directory, "initial.txt"), "utf8")
    const firstPoll = readFileSync(join(directory, "first-poll.txt"), "utf8")
    const polls = Number(readFileSync(join(directory, "polls"), "utf8"))
    if (process.env.AGENTRUN_TEST_EVIDENCE) {
      const pids = new Set(
        Array.from({ length: depth + 2 }, (_, n) => join(directory, `ready-${n}`))
          .filter(existsSync).map((file) => Number(JSON.parse(readFileSync(file, "utf8")).pid)),
      )
      const family = (table: string) =>
        table.split("\n").filter((line) => pids.has(Number(line.trim().split(/\s+/)[0])))
      const escalation = join(directory, "escalation.txt")
      const final = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8" })
      writeFileSync(
        join(process.env.AGENTRUN_TEST_EVIDENCE, `late-${verified}-${kind}-${depth}-${outcome}.json`),
        JSON.stringify(
          {
            result: inspect(result, { depth: 8 }),
            signals,
            polls,
            initial: family(initial),
            firstPoll: family(firstPoll),
            final: family(final.stdout),
            escalation: existsSync(escalation) ? family(readFileSync(escalation, "utf8")) : [],
          },
          null,
          2,
        ),
      )
    }
    if (outcome === "reused parent") {
      expect(firstPoll.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === leader.pid)).toBe(false)
    }
    const rows = (text: string) => text.split("\n").map((line) => line.trim().split(/\s+/).slice(0, 3).map(Number))
    if (nested !== undefined) {
      expect(rows(initial).some(([pid]) => pid === nested.pid)).toBe(false)
      if (outcome === "escalation fork") {
        expect(rows(firstPoll).some(([pid]) => pid === nested.pid)).toBe(false)
        expect(rows(readFileSync(join(directory, "escalation.txt"), "utf8")))
          .toContainEqual([nested.pid, nested.parent, nested.pid])
      } else {
        expect(rows(firstPoll)).toContainEqual([
          nested.pid,
          outcome === "between snapshots" ? 1 : nested.parent,
          outcome === "moved group" ? leader.pid : nested.pid,
        ])
        if (outcome === "moved group") {
          expect(rows(readFileSync(join(directory, "moved.txt"), "utf8"))).toContainEqual([nested.pid, 1, nested.pid])
        }
      }
    }
    if (!verified) expect(signals).toEqual([])
    if (verified && outcome !== "escalation fork") {
      const initialGroups = [
        leader.pid!,
        ...(depth === 2 && outcome !== "reused parent"
          ? [JSON.parse(readFileSync(join(directory, "ready-1"), "utf8")).pid]
          : []),
      ]
      expect(signals).toEqual(initialGroups.map((pid: number) => ({ pid: -pid, signal: "SIGTERM" })))
    }
    if (nested !== undefined) expect(signals.some(({ pid }) => pid === -nested.pid)).toBe(false)
    if (outcome === "forks again") {
      const later: { pid: number; parent: number } = JSON.parse(
        readFileSync(join(directory, `ready-${depth + 1}`), "utf8"),
      )
      const secondPoll = readFileSync(join(directory, "second-poll.txt"), "utf8")
      expect(rows(secondPoll)).toContainEqual([later.pid, nested!.pid, later.pid])
      expect(rows(secondPoll).some(([pid]) => pid === leader.pid)).toBe(false)
      expect(() => realKill(later.pid, 0)).not.toThrow()
    } else if (["live", "escalation fork", "between snapshots", "moved group"].includes(outcome)) {
      expect(() => realKill(nested!.pid, 0)).not.toThrow()
    }
    expect(result._tag, inspect(result, { depth: 8 })).toBe(
      (outcome === "exits" || outcome === "reused parent" || outcome === "between snapshots") ? "Success" : "Failure",
    )
    if (!["exits", "reused parent", "between snapshots"].includes(outcome)) expect(polls).toBe(80)
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
}, 60000)
