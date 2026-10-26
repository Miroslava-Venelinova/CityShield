// Migrate, then apply a generated seed to D1 — seed.sql and the street-geometry
// chunks generate-seed.mjs writes beside it — in the one order that works.
//
//   node seeds/apply.mjs --local|--remote            generate seeds/seed.sql, apply it
//   node seeds/apply.mjs --local|--remote --reseed   …wrapped in reseed-pre/-post.sql
//   node seeds/apply.mjs --local|--remote --sql F    apply an already generated F
//                                                    (tools/osm-seed-builder's output)
//
// This used to be one `&&` chain per npm script. The geometry made that
// unworkable: it has to be split into files local D1 can swallow (see
// MAX_FILE_BYTES in generate-seed.mjs), and how many there are is only known
// after generating. Stops at the first failing step — applying a seed onto a
// schema whose migration failed only compounds it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, "..");
const DATABASE = "cityshield-db";

const args = process.argv.slice(2);
const scope = args.includes("--remote") ? "--remote" : args.includes("--local") ? "--local" : null;
if (!scope) {
  console.error("Say which database: --local or --remote.");
  process.exit(2);
}
const reseed = args.includes("--reseed");
const sqlIndex = args.indexOf("--sql");
const given = sqlIndex === -1 ? null : resolve(args[sqlIndex + 1] ?? "");

/**
 * Run a Node script in backend/, streaming its output; exit on failure.
 *
 * The current Node binary on a script path rather than `npx …` through a shell:
 * npx is a .cmd shim on Windows, which spawn only runs with `shell: true`, and a
 * shell concatenates arguments unescaped — a path with a space in it breaks.
 */
function run(script, argv) {
  console.log(`\n> ${basename(script)} ${argv.join(" ")}`);
  const result = spawnSync(process.execPath, [script, ...argv], { cwd: backend, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nStopped: \`${basename(script)} ${argv.join(" ")}\` exited with ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

const wrangler = join(backend, "node_modules", "wrangler", "bin", "wrangler.js");

/** The geometry chunks beside a seed file, in apply order (1, 2, …, 10 — not 1, 10, 2). */
function wayChunks(sqlFile) {
  const prefix = `${basename(sqlFile, ".sql")}.ways.`;
  return readdirSync(dirname(sqlFile))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sql"))
    .map((name) => ({ name, n: Number(name.slice(prefix.length, -".sql".length)) }))
    .filter(({ n }) => Number.isInteger(n))
    .sort((a, b) => a.n - b.n)
    .map(({ name }) => join(dirname(sqlFile), name));
}

run(wrangler, ["d1", "migrations", "apply", DATABASE, scope]);

const sqlFile = given ?? join(here, "seed.sql");
if (!given) run(join(here, "generate-seed.mjs"), []);
if (!existsSync(sqlFile)) {
  console.error(`${sqlFile} does not exist — generate it first.`);
  process.exit(1);
}

const files = [
  ...(reseed ? [join(here, "reseed-pre.sql")] : []),
  sqlFile,
  ...wayChunks(sqlFile),
  ...(reseed ? [join(here, "reseed-post.sql")] : []),
];
for (const file of files) run(wrangler, ["d1", "execute", DATABASE, scope, `--file=${file}`]);
console.log(`\nApplied ${files.length} file(s) to ${DATABASE} (${scope.slice(2)}).`);
