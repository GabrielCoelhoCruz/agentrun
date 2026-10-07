import { constants } from "node:os"

export const subprocessFailure = (cause: unknown, timeoutMs: number): string => {
  const field = (name: string): unknown =>
    typeof cause === "object" && cause !== null ? Reflect.get(cause, name) : undefined
  const code = field("code")
  const signal = field("signal")
  const killed = field("killed")
  const stderr = field("stderr")
  const text = typeof stderr === "string" ? stderr : ""
  const prefix = text.slice(0, 4096).toLowerCase()
  return JSON.stringify({
    code: typeof code === "number" && Number.isSafeInteger(code)
      ? code
      : typeof code === "string"
          && (Object.hasOwn(constants.errno, code) || ["ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(code))
      ? code
      : null,
    signal: typeof signal === "string" && Object.hasOwn(constants.signals, signal) ? signal : null,
    killed: typeof killed === "boolean" ? killed : null,
    timeoutMs,
    stderr: {
      present: text.length > 0,
      context: [
        "permission denied",
        "operation not permitted",
        "no such file or directory",
        "resource temporarily unavailable",
        "cannot allocate memory",
        "maxbuffer",
        "timed out",
        "aborted",
      ].filter((phrase) => prefix.includes(phrase)),
      truncated: text.length > 4096,
    },
  })
}
