// Spike C1 (Pi). Decides SDK vs subprocess for the Pi adapter.
// Questions answered, in order:
//   1. Do N in-process sessions with distinct cwd write to the right directory?
//   2. Does abort() on one session leave the others running?
//   3. Does a child process started by the agent (sleep) survive abort()?
//   4. Do built-in tools prompt for approval when embedded, or run unconditionally?
//   5. Which event types and usage shape does the SDK emit?
//   6. RSS with all sessions active.
// Run: mise exec -- node spikes/pi/parallel-sessions.ts

import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent"

const SLEEP_MARKER = "sleep 123"
const ABORT_AFTER_MS = 8_000
const HARD_TIMEOUT_MS = 180_000

type Summary = {
	eventTypes: Record<string, number>
	toolCalls: Array<string>
	usageSamples: Array<unknown>
	errors: Array<string>
}

async function makeSession(cwd: string) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
	const settingsManager = SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-6-astra" })
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	})
	await resourceLoader.reload()
	const { session } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		resourceLoader,
		tools: ["read", "bash", "edit", "write"],
	})
	const summary: Summary = { eventTypes: {}, toolCalls: [], usageSamples: [], errors: [] }
	session.subscribe((event: any) => {
		summary.eventTypes[event.type] = (summary.eventTypes[event.type] ?? 0) + 1
		if (event.type === "tool_execution_start") summary.toolCalls.push(event.toolName)
		if (event.type === "message_update" && event.usage && summary.usageSamples.length < 2) {
			summary.usageSamples.push(event.usage)
		}
		if (event.type === "error") summary.errors.push(JSON.stringify(event).slice(0, 300))
		if (event.type === "message_end") summary.errors.push("message_end: " + JSON.stringify({ role: event.message?.role, stopReason: event.message?.stopReason, errorMessage: event.message?.errorMessage, content: event.message?.content }).slice(0, 700))
	})
	return { session, summary }
}

function sleepSurvivors(): Array<string> {
	try {
		return execSync(`pgrep -f "${SLEEP_MARKER}"`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)
	} catch {
		return []
	}
}

const started = Date.now()
const hardTimeout = setTimeout(() => {
	console.error("HARD TIMEOUT. A prompt never resolved. Likely an approval prompt or a hang.")
	process.exit(2)
}, HARD_TIMEOUT_MS)

const dirs = await Promise.all([1, 2, 3].map(() => mkdtemp(join(tmpdir(), "agentrun-spike-pi-"))))
const abortDir = await mkdtemp(join(tmpdir(), "agentrun-spike-pi-abort-"))

const writers = await Promise.all(dirs.map((d) => makeSession(d)))
const aborter = await makeSession(abortDir)
const model = writers[0]!.session.model
const rssAllActive = () => Math.round(process.memoryUsage().rss / 1024 / 1024)

const writerRuns = writers.map(({ session }, i) =>
	session.prompt(
		`Create a file named hello-${i + 1}.txt in the current working directory containing exactly the text "${i + 1}" and nothing else. Use the write tool. Do not run any other tool. Do not explain.`,
	),
)

let abortLatencyMs = -1
const aborterRun = (async () => {
	const run = aborter.session.prompt(
		`Run the shell command "${SLEEP_MARKER}" using the bash tool and wait for it to finish. Then reply "done".`,
	)
	await new Promise((r) => setTimeout(r, ABORT_AFTER_MS))
	const rssPeak = rssAllActive()
	const survivorsBeforeAbort = sleepSurvivors()
	const t0 = Date.now()
	await aborter.session.abort()
	abortLatencyMs = Date.now() - t0
	await run.catch((e) => aborter.summary.errors.push(`prompt rejected after abort: ${String(e).slice(0, 200)}`))
	return { rssPeak, survivorsBeforeAbort }
})()

const [{ rssPeak, survivorsBeforeAbort }] = await Promise.all([aborterRun, ...writerRuns])
await new Promise((r) => setTimeout(r, 1_000))
const survivorsAfterAbort = sleepSurvivors()

const files = dirs.map((d, i) => {
	const p = join(d, `hello-${i + 1}.txt`)
	return { dir: d, exists: existsSync(p), content: existsSync(p) ? readFileSync(p, "utf8") : null }
})
const crossWrites = dirs.flatMap((d, i) =>
	[1, 2, 3].filter((n) => n !== i + 1 && existsSync(join(d, `hello-${n}.txt`))).map((n) => `${d} has hello-${n}.txt`),
)

for (const { session } of [...writers, aborter]) session.dispose()
if (survivorsAfterAbort.length > 0) execSync(`pkill -f "${SLEEP_MARKER}" || true`)
clearTimeout(hardTimeout)

const result = {
	date: new Date().toISOString(),
	model: model ? `${model.provider}/${model.id}` : "unknown",
	durationMs: Date.now() - started,
	rssPeakMb: rssPeak,
	files,
	crossWrites,
	abort: {
		latencyMs: abortLatencyMs,
		sleepAliveBeforeAbort: survivorsBeforeAbort.length,
		sleepAliveAfterAbort: survivorsAfterAbort.length,
		otherSessionsFinished: files.every((f) => f.exists),
	},
	approvalPromptObserved: false,
	writers: writers.map((w) => w.summary),
	aborter: aborter.summary,
}
writeFileSync(new URL("./result.json", import.meta.url), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ ...result, writers: undefined, aborter: undefined }, null, 2))
console.log("event types (writer 1):", Object.keys(writers[0]!.summary.eventTypes).join(" "))
console.log("tool calls (writer 1):", writers[0]!.summary.toolCalls.join(" "))
console.log("usage sample:", JSON.stringify(writers[0]!.summary.usageSamples[0]))
console.log("aborter errors:", aborter.summary.errors)
process.exit(0)
