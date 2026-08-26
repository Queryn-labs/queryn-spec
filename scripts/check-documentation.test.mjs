import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractMermaidBlocks, parseFrontmatter } from "./check-documentation.mjs";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const scanner = path.join(scriptsRoot, "check-documentation.mjs");
const fixtures = path.join(scriptsRoot, "documentation", "fixtures");

function runScanner(argumentsList) {
  return spawnSync(process.execPath, [scanner, ...argumentsList], {
    cwd: path.resolve(scriptsRoot, ".."),
    encoding: "utf8",
    timeout: 180_000
  });
}

function fixtureConfig(name) {
  return path.join(fixtures, name);
}

test("D1 hard-fails a missing queryn-docs path from a code arrow", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check.json"), "--only", "D1"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[D1\]/u);
  assert.match(result.stdout, /adr-9999-missing\.md/u);
});

test("D2 validates YAML frontmatter and ADR lifecycle rules", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check.json"), "--only", "D2"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[D2\]/u);
  assert.match(result.stdout, /supersededBy|archive|adrStatus/u);
});

test("D2 ignores prose status and ordinary archived pages", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check-d2-clean.json"), "--only", "D2"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Documentation checks passed/u);
});

test("D3 compares ProjectFormatVersion with migration source and pages", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check.json"), "--only", "D3"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[D3\]/u);
});

test("D3 keeps hostVersion outside the project format comparison", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check-d3-clean.json"), "--only", "D3"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Documentation checks passed/u);
});

test("D4 renders every Mermaid block and rejects planted syntax errors", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check.json"), "--only", "D4"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[D4\]/u);
});

test("D4 accepts a Mermaid block with a Cyrillic node identifier", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check-d4-clean.json"), "--only", "D4"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Documentation checks passed/u);
});

test("D5 hard-fails a README that misses the six required H2 sections", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check.json"), "--only", "D5"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[D5\]/u);
  assert.match(result.stdout, /Границы|Stack|Документация/u);
});

test("D5 accepts the complete README template", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check-d5-clean.json"), "--only", "D5"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("D7 reports stale mappings as warnings without failing the gate", () => {
  const result = runScanner(["--config", fixtureConfig("doc-check-d7-warning.json"), "--only", "D7"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[D7\]/u);
  assert.match(result.stdout, /Documentation checks passed/u);
});

test("frontmatter parser does not inspect the document body", () => {
  const parsed = parseFrontmatter("---\nauthority: normative\nlifecycle: active\n---\n## Статус\nПринято\n");
  assert.equal(parsed.data.authority, "normative");
  assert.equal(parsed.data.lifecycle, "active");
  assert.equal(parsed.data.adrStatus, undefined);
});

test("Mermaid extraction recognizes fenced blocks and unclosed fences", () => {
  const blocks = extractMermaidBlocks("before\n```mermaid\nflowchart TD\n  A --> B\n```\nafter\n~~~mermaid\nflowchart TD\n  C --> D\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].unclosed, false);
  assert.equal(blocks[1].unclosed, true);
});
