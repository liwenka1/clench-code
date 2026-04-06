import { runCliEntry } from "./cli/router";

runCliEntry(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
