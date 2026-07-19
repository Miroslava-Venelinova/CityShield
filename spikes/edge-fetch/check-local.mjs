// Local baseline for the edge-fetch spike: runs the exact same checks as the
// deployed Worker, but from this machine's IP. Usage: node check-local.mjs
import { runAllChecks } from "./src/checks.mjs";

const results = await runAllChecks();
console.log(JSON.stringify({ ranFrom: "local", checkedAt: new Date().toISOString(), allOk: results.every((r) => r.ok), results }, null, 2));
