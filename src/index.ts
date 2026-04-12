import { runCliEntry } from "./cli/router";
import { inferCliOutputFormat, writeCliError } from "./cli/error-output";

const argv = process.argv.slice(2);

runCliEntry(argv).catch((error) => {
  writeCliError(error, inferCliOutputFormat(argv));
  process.exitCode = 1;
});
