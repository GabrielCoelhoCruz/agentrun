import type { RunEvent, RunState, TaskStatus } from "@agentrun/core"
import { Effect } from "effect"
import { manageDiagnostics, safeText } from "./output.js"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const clip = (text: string, width: number): string => {
  let result = ""
  let used = 0
  for (const { segment } of segmenter.segment(safeText(text).replace(/\n/g, " "))) {
    // Reserve up to two cells per visible code point. This overestimates joined emoji,
    // but cannot wrap complex Unicode clusters into a task's next row.
    const cells = [...segment].reduce(
      (sum, char) => sum + (/^(?:\p{Mark}|\u200d|\ufe0e|\ufe0f)$/u.test(char) ? 0 : char.codePointAt(0)! < 127 ? 1 : 2),
      0,
    )
    if (used + cells > width) break
    result += segment
    used += cells
  }
  return result
}
const append = (buffer: string[], text: string) => {
  const lines = safeText(text.slice(-4096 * 1000)).split("\n").filter((line) => line.length > 0)
    .slice(-1000).map((line) => line.slice(0, 4096))
  buffer.push(...lines)
  if (buffer.length > 1000) buffer.splice(0, buffer.length - 1000)
}
const agentDetail = (event: Extract<RunEvent, { _tag: "TaskAgentEvent" }>["event"]): string => {
  switch (event._tag) {
    case "Text":
      return event.text
    case "ToolCall":
      return `Tool: ${event.name}`
    case "ToolResult":
      return `${event.isError ? "Tool error" : "Tool result"}: ${event.summary}`
    case "Failed":
      return event.reason
    case "Completed":
      return event.result
    case "Retry":
      return `Retry ${event.attempt}: ${event.reason}`
    case "Usage":
      return `Tokens: ${event.inputTokens} in, ${event.outputTokens} out`
    case "Started":
      return "Agent started"
  }
}
export const progress = (event: RunEvent): string => {
  switch (event._tag) {
    case "TaskTransition":
      return `Task ${event.taskId}: ${event.status._tag}${
        event.status._tag === "failed" ? `: ${event.status.reason}` : ""
      }`
    case "TaskAgentEvent":
      return `Task ${event.taskId}: ${agentDetail(event.event)}`
    case "TaskWarning":
      return `Task ${event.taskId}: ${event.message}`
    case "TaskDeliverable":
      return `Task ${event.taskId}: saved branch ${event.branch}`
    case "RunFinished":
      return `Run ${event.runId}: finished`
  }
}

export const makePanel = (state: RunState) => {
  const tasks = state.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: state.status[task.id] ?? { _tag: "pending" } as TaskStatus,
    logs: [] as string[],
  }))
  for (const task of tasks) if (task.status._tag === "failed") append(task.logs, task.status.reason)
  const diagnostics: string[] = []
  let finished = false
  return {
    logs: (id: string): readonly string[] => tasks.find((task) => task.id === id)?.logs ?? [],
    diagnostic: (text: string, id?: string) => {
      const task = tasks.find((task) => task.id === id)
      append(task?.logs ?? diagnostics, text)
      if (diagnostics.length > 20) diagnostics.splice(0, diagnostics.length - 20)
    },
    event: (event: RunEvent) => {
      if (event._tag === "RunFinished") {
        finished = true
        return
      }
      const task = tasks.find((task) => task.id === event.taskId)
      if (!task) return
      if (event._tag === "TaskTransition") {
        task.status = event.status
        if (event.status._tag === "failed") append(task.logs, event.status.reason)
      } else if (event._tag === "TaskAgentEvent") append(task.logs, agentDetail(event.event))
      else if (event._tag === "TaskWarning") append(task.logs, event.message)
      else append(task.logs, `Saved branch ${event.branch}`)
    },
    lines: (columns: number, rows: number): string[] => {
      const height = Math.max(1, rows - 1)
      const width = Math.max(1, columns - 1)
      const complete = tasks.filter((task) => task.status._tag === "succeeded").length
      const lines = [`agentrun: ${finished ? "finished" : "running"} | ${complete}/${tasks.length} succeeded`]
      const logCount = Math.min(2, Math.max(0, Math.floor((height - 1 - tasks.length) / Math.max(1, tasks.length))))
      for (const task of tasks) {
        lines.push(`${task.id} [${task.status._tag}] ${task.title}`)
        if (logCount > 0) { for (const log of task.logs.slice(-logCount)) lines.push(`  ${log}`) }
      }
      lines.push(...diagnostics.slice(-2).map((line) => `Warning: ${line}`))
      if (lines.length > height) {
        lines.length = height
        if (tasks.length + 1 > height) {
          lines[height - 1] = `${tasks.length - Math.max(0, height - 2)} more tasks; enlarge terminal`
        }
      }
      return lines.map((line) => clip(line, width))
    },
  }
}

export const panelScoped = (state: RunState, write: (chunk: string) => void = (chunk) => {
  process.stdout.write(chunk)
}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const panel = makePanel(state)
      let timer: ReturnType<typeof setTimeout> | undefined
      const dimensions = () => [process.stdout.columns || 80, process.stdout.rows || 24] as const
      const draw = () => {
        timer = undefined
        const [columns, rows] = dimensions()
        write(`\x1b[H\x1b[2J${panel.lines(columns, rows).join("\r\n")}\r\n`)
      }
      const schedule = () => {
        if (!timer) timer = setTimeout(draw, 100)
      }
      const restoreDiagnostics = manageDiagnostics((text, id) => {
        panel.diagnostic(text, id)
        schedule()
      })
      const resize = () => {
        schedule()
      }
      process.stdout.on("resize", resize)
      // A separate terminal screen prevents resize/reflow from damaging previous shell output.
      return {
        start: () => {
          write("\x1b[?1049h\x1b[?25l")
          draw()
        },
        event: (event: RunEvent) => {
          panel.event(event)
          schedule()
        },
        close: () => {
          if (timer) clearTimeout(timer)
          process.stdout.removeListener("resize", resize)
          restoreDiagnostics()
          const [columns, rows] = dimensions()
          try {
            draw()
            write(`\x1b[?1049l${panel.lines(columns, rows).join("\n")}\n`)
          } finally {
            write("\x1b[?25h")
          }
        },
      }
    }),
    (panel) =>
      Effect.sync(() => {
        panel.close()
      }),
  ).pipe(Effect.tap((panel) =>
    Effect.sync(() => {
      panel.start()
    })
  ))
