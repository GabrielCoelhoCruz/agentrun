import { stripVTControlCharacters } from "node:util"

export const safeText = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- This is the terminal control trust boundary.
  stripVTControlCharacters(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")

let diagnosticSink: ((text: string, taskId?: string) => void) | undefined
export const diagnostic = (text: string, taskId?: string): void => {
  if (diagnosticSink) diagnosticSink(text, taskId)
  else process.stderr.write(safeText(text))
}
export const manageDiagnostics = (sink: (text: string, taskId?: string) => void): () => void => {
  const previous = diagnosticSink
  diagnosticSink = sink
  return () => {
    diagnosticSink = previous
  }
}

export const restoreTerminal = (): void => {
  if (diagnosticSink) process.stdout.write("\x1b[?1049l\x1b[?25h")
}
