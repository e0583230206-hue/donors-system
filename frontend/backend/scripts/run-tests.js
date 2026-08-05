// scripts/run-tests.js — runs every *.test.js file in frontend/backend (and
// frontend/backend/scripts) the same way they're already meant to be run
// manually ("הרצה: node <file>.test.js", per each file's own header comment):
// as an independent `node` process that does its own assert-based checks and
// exits non-zero on failure.
//
// Before this script, nothing wired these test files into anything — 17
// files with real coverage existed but were never actually run except by
// hand (see production audit: "deploy.yml never runs them"). This is that
// wiring: `npm test` runs this, and .github/workflows/deploy.yml's test job
// runs `npm test` before the deploy job is allowed to start.
//
// Usage: node scripts/run-tests.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BACKEND_DIR = path.join(__dirname, "..");
const TEST_DIRS = [
  BACKEND_DIR,
  path.join(BACKEND_DIR, "scripts"),
  // ai/tests holds the AI subsystem's own *.test.js files (added alongside
  // the Itzik Net action framework) — included here so `npm test` actually
  // covers them instead of only the hand-run ai/tests/regression.js.
  path.join(BACKEND_DIR, "ai", "tests"),
];

function findTestFiles(dir) {
  return fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith(".test.js"); })
    .map(function (f) { return path.join(dir, f); });
}

const testFiles = TEST_DIRS.reduce(function (acc, dir) {
  return acc.concat(findTestFiles(dir));
}, []).sort();

if (testFiles.length === 0) {
  console.error("No *.test.js files found — refusing to report a false pass.");
  process.exit(1);
}

console.log("Running " + testFiles.length + " test files...\n");

const outcomes = testFiles.map(function (file) {
  const label = path.relative(BACKEND_DIR, file);
  console.log("── " + label + " " + "─".repeat(Math.max(0, 70 - label.length)));
  const result = spawnSync(process.execPath, [file], {
    cwd: path.dirname(file),
    stdio: "inherit",
  });
  const passed = result.status === 0;
  console.log("");
  return { file: label, passed: passed };
});

const failed = outcomes.filter(function (o) { return !o.passed; });

console.log("═".repeat(72));
console.log("Summary: " + (outcomes.length - failed.length) + "/" + outcomes.length + " test files passed");
if (failed.length > 0) {
  console.log("Failed:");
  failed.forEach(function (o) { console.log("  ✗ " + o.file); });
}

process.exit(failed.length ? 1 : 0);
