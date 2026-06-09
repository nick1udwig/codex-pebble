import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { transform } from "esbuild";

const execFileAsync = promisify(execFile);
const sourcePbw = "build/codex-pebble.pbw";
const outputPbw = resolve("build/codex-pebble-release.pbw");
const workdir = await mkdtemp(join(tmpdir(), "codex-pebble-release-"));

try {
  await execFileAsync("unzip", ["-q", sourcePbw, "-d", workdir]);

  const jsPath = join(workdir, "pebble-js-app.js");
  const jsSource = await readFile(jsPath, "utf8");
  const minified = await transform(jsSource, {
    minify: true,
    legalComments: "none",
    sourcemap: false,
    target: "es2015",
  });
  await writeFile(jsPath, minified.code, "utf8");

  await rm(join(workdir, "pebble-js-app.js.map"), { force: true });
  await rm(outputPbw, { force: true });
  await execFileAsync("zip", ["-q", "-r", outputPbw, "."], { cwd: workdir });

  const [sourceStat, releaseStat] = await Promise.all([stat(sourcePbw), stat(outputPbw)]);
  console.log(`Built ${outputPbw}`);
  console.log(`Original size: ${sourceStat.size} bytes`);
  console.log(`Release size: ${releaseStat.size} bytes`);
} finally {
  await rm(workdir, { force: true, recursive: true });
}
