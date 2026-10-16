if (process.argv[2] === "report") {
  process.stderr.write("Permission denied: /private/fixture TOKEN=private-token\n")
  if (process.env.FACTORY_FIXTURE_REPORT_FAILURE === "exit") process.exit(23)
  if (process.env.FACTORY_FIXTURE_REPORT_FAILURE === "timeout") await new Promise(() => setInterval(() => {}, 1000))
}
