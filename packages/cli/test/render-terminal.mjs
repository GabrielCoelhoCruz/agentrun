import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
const root = resolve(process.argv[2])
const cases = []
for (const scenario of ["success", "failed", "interrupted", "resize", "resume", "pipe", "retry", "timeout"]) {
  const candidate = readdirSync(root).filter((name) => name.startsWith(`terminal-${scenario}-`))
    .filter((name) => {
      try {
        return statSync(join(root, name, "result.json")).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(join(root, b, "result.json")).mtimeMs - statSync(join(root, a, "result.json")).mtimeMs)[0]
  if (!candidate) throw new Error(`Missing capture: ${scenario}`)
  const dir = join(root, candidate)
  const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))
  const raw = readFileSync(join(dir, "capture.ansi"))
  if (scenario === "success" || scenario === "retry") {
    const frame = result.frames.find((frame) => frame.name === "running")
    if (!frame) throw new Error("Missing live snapshot")
    cases.push({
      name: scenario === "retry" ? "retry-backoff" : "running",
      columns: 80,
      rows: 24,
      chunks: [{ text: raw.subarray(0, frame.bytes).toString() }],
    })
  }
  if (scenario === "resume") {
    const initial = raw.toString().split("\x1b[H")[1]
    cases.push({ name: "resume-saved-statuses", columns: 80, rows: 24, chunks: [{ text: `\x1b[H${initial}` }] })
  }
  const end = scenario === "pipe" ? raw.length : raw.indexOf("\x1b[?1049l")
  const chunks = []
  let offset = 0
  for (const frame of result.frames.filter((frame) => frame.name === "resize")) {
    chunks.push({ text: raw.subarray(offset, frame.bytes).toString() })
    chunks.push({ columns: frame.columns, rows: frame.rows })
    offset = frame.bytes
  }
  const text = raw.subarray(offset, end).toString()
  chunks.push({ text: scenario === "pipe" ? text.replaceAll("\n", "\r\n") : text })
  cases.push({ name: scenario === "pipe" ? "non-TTY" : scenario, columns: 80, rows: 24, chunks })
}
const payload = JSON.stringify(cases).replaceAll("<", "\\u003c")
writeFileSync(
  join(root, "emulator", "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Step 9 terminal evidence</title>
<link rel="stylesheet" href="node_modules/@xterm/xterm/css/xterm.css">
<style>body{background:#0b1018;color:#e5e7eb;font:16px system-ui;margin:24px}section{margin-bottom:24px}h2{font-size:18px}.terminal{padding:12px;background:#10151d;width:max-content}</style>
<h1>Real terminal captures</h1><p>Saved PTY output, replayed in xterm.js 6 with Unicode graphemes. Terminal sizes: 80 × 24; resized: 32 × 12.</p>
<script src="node_modules/@xterm/xterm/lib/xterm.js"></script>
<script src="node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js"></script>
<script>window.ready=false;window.terminals=[];(async()=>{for(const item of ${payload}){
const section=document.createElement('section');section.id=item.name;const title=document.createElement('h2');title.textContent=item.name;section.append(title);
const element=document.createElement('div');element.className='terminal';section.append(element);document.body.append(section);
const terminal=new Terminal({cols:item.columns,rows:item.rows,fontSize:16,fontFamily:'Menlo,monospace',allowProposedApi:true,theme:{background:'#10151d',foreground:'#e5e7eb'},disableStdin:true});
terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());terminal.unicode.activeVersion='15-graphemes';terminal.open(element);
for(const chunk of item.chunks){if(chunk.columns)terminal.resize(chunk.columns,chunk.rows);else await new Promise(resolve=>terminal.write(chunk.text,resolve))}
window.terminals.push({name:item.name,terminal});}window.ready=true})()</script>`,
)
writeFileSync(
  join(root, "emulator", "replay-manifest.json"),
  JSON.stringify(cases.map(({ name, columns, rows }) => ({ name, columns, rows })), null, 2),
)
