import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const configPath = path.join(import.meta.dirname, "comment-hygiene", "repos.json");
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const excludedDirectoryNames = new Set(["dist", "dist-test", "node_modules", "out"]);
const issueRepositories = new Set([
  "queryn-core",
  "queryn-desktop",
  "queryn-docs",
  "queryn-sdk",
  "queryn-extensions",
  "queryn-runtime",
  "queryn-spec"
]);
const todoPattern = /^TODO\(([a-z][a-z0-9-]{1,30})#(\d{1,7})\):\s+\S/;
const bannedMarkerPattern = /\b(FIXME|HACK|XXX)\b/g;
const todoWordPattern = /\bTODO\b/g;
const cyrillicPattern = /[\u0400-\u04FF\u0500-\u052F]/u;

if (isMainModule()) {
  try {
    const { check, paths } = await parseArguments(process.argv.slice(2));
    const violations = await scanPaths(paths, check);
    printReport(violations, check);
    if (check && violations.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export { collectCommentRanges, parseArguments, scanFile, scanPaths };

async function parseArguments(argumentsList) {
  let check = false;
  let repositoryName;
  const explicitPaths = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--repo") {
      repositoryName = argumentsList[index + 1];
      if (!repositoryName || repositoryName.startsWith("--")) {
        throw new Error("--repo requires a repository name.");
      }
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      explicitPaths.push(argument);
    }
  }

  if (repositoryName && explicitPaths.length > 0) {
    throw new Error("Use --repo or explicit paths, not both.");
  }
  if (!repositoryName && explicitPaths.length === 0) {
    throw new Error("Pass --repo <name> or at least one source path.");
  }

  if (repositoryName) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const repository = config[repositoryName];
    if (!repository) {
      throw new Error(`Unknown repository ${repositoryName}. Known repositories: ${Object.keys(config).join(", ")}.`);
    }
    if (!Array.isArray(repository.paths) || typeof repository.issueTodo !== "boolean") {
      throw new Error(`Invalid comment hygiene configuration for ${repositoryName}.`);
    }
    const paths = [];
    for (const configuredPath of repository.paths) {
      for (const expandedPath of await expandConfiguredPath(configuredPath)) {
        paths.push({ path: expandedPath, repositoryName, issueTodo: repository.issueTodo });
      }
    }
    if (paths.length === 0) throw new Error(`No configured source paths found for ${repositoryName}.`);
    return { check, paths };
  }

  return {
    check,
    paths: explicitPaths.map((sourcePath) => ({
      path: path.resolve(process.cwd(), sourcePath),
      repositoryName: undefined,
      issueTodo: true
    }))
  };
}

async function scanPaths(pathEntries, check) {
  const files = new Set();
  for (const entry of pathEntries) {
    const target = await stat(entry.path).catch(() => null);
    if (!target) throw new Error(`Source path does not exist: ${entry.path}`);
    if (target.isDirectory()) {
      for (const file of await collectSourceFiles(entry.path)) files.add(file);
    } else if (target.isFile()) {
      files.add(entry.path);
    } else {
      throw new Error(`Source path is not a regular file or directory: ${entry.path}`);
    }
  }

  const violations = [];
  for (const filePath of [...files].sort()) {
    const matchingEntry = pathEntries.find((entry) => filePath === entry.path || filePath.startsWith(`${entry.path}${path.sep}`));
    const issueTodo = matchingEntry?.issueTodo ?? true;
    violations.push(...await scanFile(filePath, { issueTodo }));
  }
  violations.sort(compareViolations);
  if (!check) return violations;
  return violations;
}

async function scanFile(filePath, { issueTodo = true } = {}) {
  if (shouldExclude(filePath)) return [];
  const extension = path.extname(filePath).toLowerCase();
  if (!sourceExtensions.has(extension) || filePath.endsWith(".d.ts")) return [];

  const sourceText = await readFile(filePath, "utf8");
  const scriptKind = extension === ".tsx" || extension === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const violations = [];
  for (const range of collectCommentRanges(sourceFile, sourceText)) {
    const commentText = sourceText.slice(range.pos, range.end);
    inspectComment(commentText, range.pos, sourceText, filePath, issueTodo, violations);
  }
  return violations;
}

function collectCommentRanges(sourceFile, sourceText) {
  const ranges = new Map();
  const add = (range) => {
    if (!range || range.end <= range.pos) return;
    ranges.set(`${range.pos}:${range.end}`, { pos: range.pos, end: range.end });
  };

  // The scanner supplies exact comment tokens, while getLeadingCommentRanges
  // preserves TypeScript's trivia boundaries for comments attached to nodes.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, sourceText);
  let tokenKind;
  while ((tokenKind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    const tokenPos = scanner.getTokenPos();
    if (tokenKind === ts.SyntaxKind.SingleLineCommentTrivia || tokenKind === ts.SyntaxKind.MultiLineCommentTrivia) {
      add({ pos: tokenPos, end: scanner.getTextPos() });
    }
    for (const range of ts.getLeadingCommentRanges(sourceText, tokenPos) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(sourceText, tokenPos) ?? []) add(range);
  }

  const visit = (node) => {
    for (const range of ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(sourceText, node.getFullStart()) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(sourceText, node.end) ?? []) add(range);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...ranges.values()].sort((left, right) => left.pos - right.pos || left.end - right.end);
}

function inspectComment(commentText, commentOffset, sourceText, filePath, issueTodo, violations) {
  const bodyOffset = commentText.startsWith("//") ? 2 : 2;
  const bodyEnd = commentText.startsWith("//") ? commentText.length : Math.max(bodyOffset, commentText.length - 2);
  const body = commentText.slice(bodyOffset, bodyEnd);

  if (cyrillicPattern.test(body)) {
    addViolation(violations, filePath, sourceText, commentOffset, "cyrillic", "Comments must use English text.");
  }

  for (const match of body.matchAll(bannedMarkerPattern)) {
    addViolation(
      violations,
      filePath,
      sourceText,
      commentOffset + bodyOffset + match.index,
      "marker",
      `${match[0]} is forbidden in comments.`
    );
  }

  for (const match of body.matchAll(todoWordPattern)) {
    const todoOffset = match.index;
    const valid = issueTodo && isValidTodo(body, todoOffset);
    if (!valid) {
      addViolation(
        violations,
        filePath,
        sourceText,
        commentOffset + bodyOffset + todoOffset,
        "todo",
        issueTodo
          ? "TODO must use TODO(queryn-repo#123): reason syntax with a known repository."
          : "TODO comments are forbidden in this repository."
      );
    }
  }
}

function isValidTodo(body, todoOffset) {
  const lineStart = body.lastIndexOf("\n", todoOffset - 1) + 1;
  const lineEndIndex = body.indexOf("\n", todoOffset);
  const lineEnd = lineEndIndex === -1 ? body.length : lineEndIndex;
  const line = body.slice(lineStart, lineEnd).replace(/^\s*\*\s?/, "").trim();
  const firstTodoOffset = body.slice(lineStart, lineEnd).search(/\bTODO\b/);
  if (firstTodoOffset < 0 || todoOffset - lineStart !== firstTodoOffset) return false;
  const match = line.match(todoPattern);
  return Boolean(match && issueRepositories.has(match[1]));
}

function addViolation(violations, filePath, sourceText, offset, rule, message) {
  const { line, column } = lineAndColumn(sourceText, offset);
  violations.push({ filePath, line, column, rule, message });
}

function lineAndColumn(sourceText, offset) {
  const before = sourceText.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

function printReport(violations, check) {
  if (violations.length === 0) {
    process.stdout.write(`${check ? "Comment hygiene passed" : "Comment hygiene report is clean"}.\n`);
    return;
  }
  for (const violation of violations) {
    const relativePath = path.relative(process.cwd(), violation.filePath) || path.basename(violation.filePath);
    process.stdout.write(`${relativePath}:${violation.line}:${violation.column} [${violation.rule}] ${violation.message}\n`);
  }
  process.stdout.write(`Found ${violations.length} comment hygiene violation${violations.length === 1 ? "" : "s"}.\n`);
}

function compareViolations(left, right) {
  return left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule);
}

async function collectSourceFiles(directoryPath) {
  const files = [];
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && !excludedDirectoryNames.has(entry.name)) {
      files.push(...await collectSourceFiles(path.join(directoryPath, entry.name)));
    } else if (entry.isFile()) {
      const filePath = path.join(directoryPath, entry.name);
      if (!shouldExclude(filePath) && sourceExtensions.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith(".d.ts")) {
        files.push(filePath);
      }
    }
  }
  return files;
}

async function expandConfiguredPath(configuredPath) {
  const absolutePattern = path.resolve(root, configuredPath);
  if (!/[\*\?\[]/.test(absolutePattern)) return [absolutePattern];

  const segments = absolutePattern.split(path.sep);
  const firstPatternIndex = segments.findIndex((segment) => /[\*\?\[]/.test(segment));
  const basePath = segments.slice(0, firstPatternIndex).join(path.sep) || path.parse(absolutePattern).root;
  const matches = await expandSegments(basePath, segments.slice(firstPatternIndex));
  return matches;
}

async function expandSegments(currentPath, segments) {
  if (segments.length === 0) return [currentPath];
  const [segment, ...rest] = segments;
  if (segment === "**") {
    return [
      ...(await expandSegments(currentPath, rest)),
      ...(
        await Promise.all(
          (await readdir(currentPath, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory() && !excludedDirectoryNames.has(entry.name))
            .map((entry) => expandSegments(path.join(currentPath, entry.name), segments))
        )
      ).flat()
    ];
  }

  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  const matcher = new RegExp(`^${segment.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && matcher.test(entry.name) && !excludedDirectoryNames.has(entry.name))
        .map((entry) => expandSegments(path.join(currentPath, entry.name), rest))
    )
  ).flat();
}

function shouldExclude(filePath) {
  const segments = filePath.split(path.sep);
  return segments.some((segment) => excludedDirectoryNames.has(segment)) || filePath.endsWith(".d.ts");
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
