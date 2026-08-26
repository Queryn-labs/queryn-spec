import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const scanner = path.join(scriptsRoot, "check-comment-hygiene.mjs");
const fixtures = path.join(scriptsRoot, "comment-hygiene", "fixtures");

function runScanner(argumentsList) {
  return spawnSync(process.execPath, [scanner, ...argumentsList], {
    cwd: path.resolve(scriptsRoot, ".."),
    encoding: "utf8"
  });
}

test("comment scanner reports each planted violation in check mode", () => {
  const result = runScanner(["--check", path.join(fixtures, "cyrillic.ts"), path.join(fixtures, "markers.ts"), path.join(fixtures, "todo.ts")]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\[cyrillic\]/);
  assert.match(result.stdout, /\[marker\]/);
  assert.match(result.stdout, /\[todo\]/);
  assert.match(result.stdout, /Found \d+ comment hygiene violations\./);
});

test("report-only mode keeps migration scans non-blocking", () => {
  const result = runScanner([path.join(fixtures, "todo.ts")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[todo\]/);
});

test("valid TODO and code-like strings remain clean", () => {
  const result = runScanner(["--check", path.join(fixtures, "clean.ts"), path.join(fixtures, "valid-todo.ts")]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Comment hygiene passed/);
});

test("fixtures exercise the literal false positives explicitly", async () => {
  const source = await readFile(path.join(fixtures, "clean.ts"), "utf8");
  assert.match(source, /Русский текст/);
  assert.match(source, /\/\/ const/);
  assert.match(source, /lowercase todo/);
});
