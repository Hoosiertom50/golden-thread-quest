// project-setup-check: checks that this Playwright project keeps generated output, environment
// files and credentials out of Git.
//
// It checks that:
//   - every kind of file a test run produces (results, traces, screenshots, downloads, reports)
//     and every environment file is ignored by Git, and names the rule that ignores it;
//   - the project's own files (package, lockfile, configuration, tests, demo app, README and the
//     example environment file) are not ignored, so nothing needed is left out by mistake;
//   - Playwright's browsers are stored outside the repository;
//   - no environment file is among the files Git would commit;
//   - no credential is found in any file Git would commit, using the repository's own secret
//     scanner (tools/secret_scan.py), the same one the quest app uses.
//
// It runs Git and the scanner and only reads; it changes nothing. "Files Git would commit" means
// every tracked file plus every new file that isn't ignored.
//
// Run from this folder (participant/tests/playwright):
//   npm run check-setup
// or from anywhere inside the repository:
//   node participant/tests/playwright/tools/project-setup-check.ts
// It needs Git, and the repository's Python environment (.venv) for the scanner.
// Exit status: 0 passed, 1 failed, 2 Git or the scanner couldn't be run.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";

// Example paths for every kind of file a run produces, relative to this project. Git is asked
// whether each would be ignored; the files don't need to exist.
const MUST_BE_IGNORED: { path: string; what: string }[] = [
  { path: "node_modules/@playwright/test/package.json", what: "installed packages" },
  { path: "test-results/smoke-chromium/trace.zip", what: "a trace" },
  { path: "test-results/smoke-chromium/test-failed-1.png", what: "a failure screenshot" },
  { path: "test-results/smoke-chromium/downloads/ticket.pdf", what: "a file downloaded during a test" },
  { path: "playwright-report/index.html", what: "the HTML report" },
  { path: "blob-report/report.zip", what: "a merged-report blob" },
  { path: "playwright/.cache/component.js", what: "Playwright's build cache" },
  { path: ".env", what: "an environment file" },
  { path: ".env.local", what: "a local environment file" },
];

// The project's own files, which must be committed.
const MUST_NOT_BE_IGNORED: string[] = [
  "package.json",
  "package-lock.json",
  "playwright.config.ts",
  "README.md",
  "tests/smoke.spec.ts",
  "demo-app/index.html",
  "demo-app/server.js",
  ".gitignore",
  ".env.example",
];

class CannotRun extends Error {}

// A path's real location, following links (on macOS, /var is a link to /private/var), so it can be
// compared with the repository's. The folder may not exist yet, so the nearest existing folder
// above it is resolved and the rest added back.
function realLocation(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full ? full : join(realLocation(parent), basename(full));
}

function run(command: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw new CannotRun(`couldn't run ${command}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function main(): number {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const top = run("git", ["rev-parse", "--show-toplevel"], project);
  if (top.status !== 0) throw new CannotRun("this folder isn't inside a Git repository");
  const root = top.stdout.trim();
  const projectPath = relative(root, project);

  const out: string[] = [];
  const check = (passed: boolean, text: string, details: string[] = []): void => {
    out.push(`${passed ? "PASS" : "FAIL"}  ${text}`);
    for (const line of details) out.push(`      ${line}`);
  };
  out.push(`project-setup-check ${VERSION}`);
  out.push(`project: ${projectPath}`);

  // Generated output and environment files are ignored. "--no-index" asks about the path itself,
  // whether or not a file is there; "-v" names the rule that matched.
  const ignored: string[] = [];
  const notIgnored: string[] = [];
  for (const { path, what } of MUST_BE_IGNORED) {
    const full = join(projectPath, path);
    const answer = run("git", ["check-ignore", "--no-index", "-v", full], root);
    if (answer.status === 0) {
      const rule = answer.stdout.split("\t")[0] ?? "";
      ignored.push(`${what}: ${full} (rule ${rule})`);
    } else {
      notIgnored.push(`${what}: ${full} is NOT ignored`);
    }
  }
  check(
    notIgnored.length === 0,
    `generated output and environment files are ignored by Git (${ignored.length} of ${MUST_BE_IGNORED.length})`,
    [...notIgnored, ...ignored],
  );

  // The project's own files are not ignored.
  const wronglyIgnored = MUST_NOT_BE_IGNORED.filter(
    (path) => run("git", ["check-ignore", "--no-index", "-q", join(projectPath, path)], root).status === 0,
  );
  check(
    wronglyIgnored.length === 0,
    `the project's own files are not ignored (${MUST_NOT_BE_IGNORED.length - wronglyIgnored.length} of ${MUST_NOT_BE_IGNORED.length})`,
    wronglyIgnored.map((path) => `${join(projectPath, path)} is ignored, so it would be left out`),
  );

  // Browsers are kept out of Git: in Playwright's own cache folder outside the repository (the
  // default), in node_modules when PLAYWRIGHT_BROWSERS_PATH is "0", or in the folder that variable
  // names, which must be outside the repository or ignored by Git.
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  let browserPlace: string;
  let browsersOk: boolean;
  if (browsers === undefined || browsers === "") {
    browserPlace = "Playwright's own cache folder, outside the repository";
    browsersOk = true;
  } else if (browsers === "0") {
    browserPlace = "node_modules, which is ignored";
    browsersOk = run("git", ["check-ignore", "--no-index", "-q", join(projectPath, "node_modules/x")], root).status === 0;
  } else {
    const inside = relative(realLocation(root), realLocation(browsers));
    const isInside = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
    browserPlace = isInside ? `${inside}, inside the repository` : "a folder outside the repository";
    browsersOk = !isInside || run("git", ["check-ignore", "--no-index", "-q", join(inside, "x")], root).status === 0;
  }
  check(
    browsersOk,
    `downloaded browsers are kept out of Git (${browserPlace})`,
    browsersOk ? [] : ["PLAYWRIGHT_BROWSERS_PATH puts the browsers inside the repository where Git would commit them"],
  );

  // The files Git would commit: everything tracked, plus new files that aren't ignored.
  const listed = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root);
  if (listed.status !== 0) throw new CannotRun("Git couldn't list the repository's files");
  const files = listed.stdout.split("\0").filter((file) => file !== "");

  // No environment file would be committed (the example file is allowed).
  const envFiles = files.filter((file) => /(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example"));
  check(
    envFiles.length === 0,
    `no environment file is among the ${files.length} files Git would commit`,
    envFiles.map((file) => `${file} would be committed`),
  );

  // No credential in any file Git would commit, by the repository's own scanner. It prints
  // "path:line:column: [pattern] description" for each finding, never the secret itself.
  const python = join(root, ".venv", "bin", "python");
  const scanner = join(root, "tools", "secret_scan.py");
  if (!existsSync(python) || !existsSync(scanner)) {
    throw new CannotRun("the repository's secret scanner (.venv and tools/secret_scan.py) isn't set up");
  }
  const scan = spawnSync(python, [scanner, ...files], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (scan.error) throw new CannotRun(`couldn't run the secret scanner: ${scan.error.message}`);
  const scanLines = `${scan.stdout ?? ""}${scan.stderr ?? ""}`.trim().split("\n").filter((line) => line !== "");
  const summary = scanLines.find((line) => line.startsWith("secret-scan:")) ?? "";
  const clean = scan.status === 0 && /, 0 finding\(s\)$/.test(summary);
  check(
    clean,
    `no credential found in the files Git would commit (${summary.replace("secret-scan: ", "") || "no summary from the scanner"})`,
    clean ? [] : scanLines.filter((line) => !line.startsWith("secret-scan:")),
  );

  const failed = out.some((line) => line.startsWith("FAIL"));
  out.push(failed ? "RESULT: FAILED" : "RESULT: PASSED");
  console.log(out.join("\n"));
  return failed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  // Anything that stops the check from running is reported as "couldn't check" (2), never as an
  // ordinary FAIL (1).
  const message = error instanceof Error ? error.message : String(error);
  console.error(`project-setup-check ${VERSION}: ${error instanceof CannotRun ? message : `stopped unexpectedly: ${message}`}`);
  process.exitCode = 2;
}
