import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);
const specRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(specRoot, "..");
const defaultConfigPath = path.join(specRoot, "contract", "doc-check.json");
const codeExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const excludedDirectoryNames = new Set([".git", ".vitepress", "dist", "dist-test", "node_modules", "out"]);
const defaultRules = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];
const projectVersionPattern = /(?<![\d.])\d+\.\d+(?![\d.])/gu;
const mermaidOpeningPattern = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t].*)?$/iu;
const readmeSectionAliases = {
  "Статус": ["статус", "status"],
  Stack: ["stack", "стек", "технологии"],
  "Команды": ["команды", "commands"],
  "Границы": ["границы", "boundaries", "scope"],
  "Связанные репозитории": ["связанные репозитории", "связанные", "related repositories", "related"],
  "Лицензия": ["лицензия", "license"]
};

if (isMainModule()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const configPath = path.resolve(process.cwd(), options.config ?? defaultConfigPath);
    const config = await readConfig(configPath);
    const result = await checkDocumentation(config, {
      rules: options.rules,
      skipBuild: options.skipBuild,
      configPath
    });
    printResult(result, options.json);
    if (result.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export {
  checkDocumentation,
  collectMarkdownFiles,
  extractCodeComments,
  extractMermaidBlocks,
  parseArguments,
  parseFrontmatter,
  readConfig,
  scanCodeArrowReferences,
};

function parseArguments(argumentsList) {
  const options = { config: undefined, rules: undefined, skipBuild: false, json: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--config") {
      options.config = requiredArgument(argumentsList, ++index, "--config");
    } else if (argument === "--only" || argument === "--rule") {
      const value = requiredArgument(argumentsList, ++index, argument);
      options.rules = parseRules(value);
    } else if (argument === "--skip-build") {
      options.skipBuild = true;
    } else if (argument === "--check") {
      // Keep parity with the comment-hygiene CLI. Documentation checks are
      // always hard-fail, so --check is accepted as an explicit no-op.
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node scripts/check-documentation.mjs [--config PATH] [--only D1,D2] [--skip-build] [--json]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function requiredArgument(argumentsList, index, option) {
  const value = argumentsList[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseRules(value) {
  const rules = [...new Set(value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))];
  if (rules.length === 0 || rules.some((rule) => !defaultRules.includes(rule))) {
    throw new Error(`Unknown documentation rule. Expected one of ${defaultRules.join(", ")}.`);
  }
  return rules;
}

async function readConfig(configPath) {
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid documentation configuration: ${configPath}`);
  return { ...parsed, _configPath: configPath };
}

async function checkDocumentation(config, { rules = defaultRules, skipBuild = false } = {}) {
  const selectedRules = [...new Set(rules)];
  const failures = [];
  const warnings = [];
  const context = { config, failures, warnings };

  for (const rule of selectedRules) {
    if (rule === "D1") await checkD1(context);
    if (rule === "D2") await checkD2(context);
    if (rule === "D3") await checkD3(context);
    if (rule === "D4") await checkD4(context);
    if (rule === "D5") await checkD5(context);
    if (rule === "D6" && !skipBuild) await checkD6(context);
    if (rule === "D7") await checkD7(context);
  }

  failures.sort(compareIssues);
  warnings.sort(compareIssues);
  return { failures, warnings, rules: selectedRules };
}

async function checkD1({ config, failures }) {
  const hygieneConfigPath = resolveConfigPath(config, config.commentHygieneConfig ?? "scripts/comment-hygiene/repos.json");
  const hygieneConfig = await readJsonOrIssue(hygieneConfigPath, failures, "D1");
  if (!hygieneConfig) return;

  const repositoryNames = config.codeArrowRepositories ?? Object.keys(hygieneConfig);
  if (!Array.isArray(repositoryNames)) {
    addIssue(failures, "D1", hygieneConfigPath, "codeArrowRepositories must be an array.");
    return;
  }

  const seenFiles = new Set();
  for (const repositoryName of repositoryNames) {
    const repository = hygieneConfig[repositoryName];
    if (!repository || !Array.isArray(repository.paths)) {
      addIssue(failures, "D1", hygieneConfigPath, `No source paths configured for ${repositoryName}.`);
      continue;
    }
    for (const configuredPath of repository.paths) {
      const matches = await expandConfiguredPath(configuredPath, config);
      if (matches.length === 0) {
        addIssue(failures, "D1", resolveConfigPath(config, configuredPath), `Configured source path does not exist: ${configuredPath}.`);
        continue;
      }
      for (const match of matches) {
        for (const filePath of await collectCodeFiles(match)) seenFiles.add(filePath);
      }
    }
  }

  for (const filePath of [...seenFiles].sort()) {
    const sourceText = await readFile(filePath, "utf8");
    const comments = extractCodeComments(filePath, sourceText);
    for (const comment of comments) {
      for (const reference of extractDocReferences(comment.text)) {
        const relativeReference = normalizeDocReference(reference.value);
        const target = relativeReference ? path.join(workspaceRoot, relativeReference) : null;
        if (!target || !(await pathExists(target))) {
          addIssue(
            failures,
            "D1",
            filePath,
            `Documentation path does not exist: ${reference.value}.`,
            comment.pos + reference.offset,
            sourceText
          );
        }
      }
    }
  }
}

async function checkD2({ config, failures }) {
  const docsRoot = resolveConfigPath(config, config.docsRoot ?? "../osnova-docs/docs");
  if (!(await pathExists(docsRoot))) {
    addIssue(failures, "D2", docsRoot, "Documentation root does not exist.");
    return;
  }

  const markdownFiles = await collectMarkdownFiles(docsRoot);
  const archiveRoots = (config.archiveRoots ?? [path.relative(specRoot, path.join(docsRoot, "archive"))])
    .map((item) => resolveConfigPath(config, item));
  const documents = [];
  for (const filePath of markdownFiles) {
    const relativePath = path.relative(docsRoot, filePath);
    const archive = archiveRoots.some((archiveRoot) => isInside(filePath, archiveRoot));
    const segments = relativePath.split(path.sep);
    const underAdrDirectory = segments.includes("adr");
    const fileName = path.basename(filePath);
    const adrSupportFile = underAdrDirectory && new Set(["index.md", "template.md", "lifecycle.md"]).has(fileName.toLowerCase());
    const looksLikeAdr = !adrSupportFile && (/^adr-\d{4}-/iu.test(fileName) || (underAdrDirectory && /^adr-/iu.test(fileName)));
    const frontmatter = await readFrontmatter(filePath, failures);
    const data = frontmatter?.data;
    documents.push({ filePath, relativePath, archive, looksLikeAdr, frontmatter, data });

    if (!data) continue;
    validateAxis(failures, filePath, data, "authority", ["normative", "informational"]);
    validateAxis(failures, filePath, data, "lifecycle", ["active", "archived"]);
    if (archive && data.lifecycle !== "archived") {
      addIssue(failures, "D2", filePath, "Documents under docs/archive/ must use lifecycle: archived.");
    }

    if (looksLikeAdr) {
      if (!underAdrDirectory) addIssue(failures, "D2", filePath, "ADR pages must remain under docs/adr/.");
      if (archive) addIssue(failures, "D2", filePath, "ADR files must not be stored under docs/archive/.");
      if (!/^adr-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(fileName)) {
        addIssue(failures, "D2", filePath, "ADR filename must match adr-NNNN-kebab-slug.md.");
      }
      validateAdrFrontmatter(failures, filePath, data);
    } else if ("adrStatus" in data || "supersededBy" in data) {
      addIssue(failures, "D2", filePath, "adrStatus and supersededBy are reserved for ADR pages.");
    }
  }

  const adrByNumber = new Map();
  for (const document of documents.filter((item) => item.looksLikeAdr && item.frontmatter?.data)) {
    const match = path.basename(document.filePath).match(/^adr-(\d{4})-/u);
    if (!match) continue;
    if (adrByNumber.has(match[1])) addIssue(failures, "D2", document.filePath, `Duplicate ADR number ${match[1]}.`);
    adrByNumber.set(match[1], document);
  }
  for (const document of documents.filter((item) => item.looksLikeAdr && item.frontmatter?.data?.adrStatus === "superseded")) {
    const targetNumber = document.frontmatter.data.supersededBy;
    if (!Number.isInteger(targetNumber) || targetNumber < 1) continue;
    const target = adrByNumber.get(String(targetNumber).padStart(4, "0"));
    if (!target || target.data?.adrStatus !== "accepted") {
      addIssue(failures, "D2", document.filePath, `supersededBy must point to an existing accepted ADR: ${String(targetNumber).padStart(4, "0")}.`);
    }
  }
}

async function checkD3({ config, failures }) {
  const schemaPath = resolveConfigPath(config, config.projectFormatSchema ?? "schemas/osnova.schema.json");
  const schema = await readJsonOrIssue(schemaPath, failures, "D3");
  if (!schema) return;
  const declaredVersions = findProjectFormatVersions(schema);
  if (declaredVersions.length === 0) {
    addIssue(failures, "D3", schemaPath, "Could not find the ProjectFormatVersion enum in the specification schema.");
    return;
  }
  const latestVersion = maxVersion(declaredVersions);

  const projectSources = config.projectFormatSources ?? ["../osnova-core/packages/project/src/migration.ts"];
  if (!Array.isArray(projectSources) || projectSources.length === 0) {
    addIssue(failures, "D3", schemaPath, "projectFormatSources must contain at least one migration source.");
    return;
  }
  const supportedVersions = new Set();
  for (const configuredPath of projectSources) {
    const filePath = resolveConfigPath(config, configuredPath);
    let sourceText;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch {
      addIssue(failures, "D3", filePath, "Project format source does not exist.");
      continue;
    }
    for (const version of extractVersionLiterals(sourceText)) supportedVersions.add(version);
  }
  if (supportedVersions.size === 0) {
    addIssue(failures, "D3", schemaPath, "No project format versions were found in @osnova/project migration sources.");
  } else if (maxVersion([...supportedVersions]) !== latestVersion) {
    addIssue(failures, "D3", schemaPath, `ProjectFormatVersion latest is ${latestVersion}, but @osnova/project supports ${maxVersion([...supportedVersions])}.`);
  }

  const pages = config.versionSensitivePages ?? [];
  if (!Array.isArray(pages)) {
    addIssue(failures, "D3", schemaPath, "versionSensitivePages must be an array.");
  } else {
    for (const entry of pages) {
      const pagePath = resolveConfigPath(config, typeof entry === "string" ? entry : entry?.path);
      let sourceText;
      try {
        sourceText = await readFile(pagePath, "utf8");
      } catch {
        addIssue(failures, "D3", pagePath, "Version-sensitive documentation page does not exist.");
        continue;
      }
      const observed = [...new Set(sourceText.match(projectVersionPattern) ?? [])].filter((version) => declaredVersions.includes(version));
      const requiredVersions = typeof entry === "object" && Array.isArray(entry.requiredVersions) ? entry.requiredVersions : [];
      for (const version of requiredVersions) {
        if (!observed.includes(version)) addIssue(failures, "D3", pagePath, `Version-sensitive page does not mention required project format ${version}.`);
      }
      if (observed.length === 0) {
        addIssue(failures, "D3", pagePath, `Version-sensitive page does not mention a ProjectFormatVersion (${latestVersion}).`);
      } else if (maxVersion(observed) !== latestVersion) {
        addIssue(failures, "D3", pagePath, `Version-sensitive page latest project format is ${maxVersion(observed)}, expected ${latestVersion}.`);
      }
    }
  }

  // hostVersion belongs to the extension-host compatibility axis. It is deliberately
  // read only for diagnostics and never contributes to supportedVersions or latestVersion.
  if (Array.isArray(config.hostVersionSources)) {
    for (const configuredPath of config.hostVersionSources) {
      const filePath = resolveConfigPath(config, configuredPath);
      if (await pathExists(filePath)) await readFile(filePath, "utf8");
    }
  }
}

async function checkD4({ config, failures }) {
  const docsRoot = resolveConfigPath(config, config.docsRoot ?? "../osnova-docs/docs");
  if (!(await pathExists(docsRoot))) {
    addIssue(failures, "D4", docsRoot, "Documentation root does not exist.");
    return;
  }
  const mermaidBlocks = [];
  for (const filePath of await collectMarkdownFiles(docsRoot)) {
    const sourceText = await readFile(filePath, "utf8");
    for (const block of extractMermaidBlocks(sourceText)) mermaidBlocks.push({ ...block, filePath, sourceText });
  }
  const mermaidConfig = config.mermaid ?? {};
  for (const block of mermaidBlocks) {
    if (block.unclosed) {
      addIssue(failures, "D4", block.filePath, "Mermaid fenced block is not closed.", block.startOffset, block.sourceText);
      continue;
    }
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "osnova-doc-check-"));
    const inputPath = path.join(temporaryDirectory, "diagram.mmd");
    const outputPath = path.join(temporaryDirectory, "diagram.svg");
    await writeFile(inputPath, `${block.body.trimEnd()}\n`, "utf8");
    try {
      const configuredCommand = mermaidConfig.command ?? "pnpm";
      const command = process.platform === "win32" && configuredCommand === "pnpm" ? "pnpm.cmd" : configuredCommand;
      const commandArgs = [...(mermaidConfig.args ?? ["exec", "mmdc"]), "--input", inputPath, "--output", outputPath, "--quiet"];
      await execFileAsync(command, commandArgs, {
        cwd: specRoot,
        timeout: Number(mermaidConfig.timeoutMs ?? 120_000),
        maxBuffer: 2 * 1024 * 1024
      });
      if (!(await pathExists(outputPath))) addIssue(failures, "D4", block.filePath, "Mermaid CLI completed without producing an SVG output.", block.startOffset, block.sourceText);
    } catch (error) {
      const detail = commandError(error);
      addIssue(failures, "D4", block.filePath, `Mermaid block failed to render: ${detail}`, block.startOffset, block.sourceText);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function checkD5({ config, failures }) {
  const readmes = config.readmes ?? [
    "../osnova-core/README.md",
    "../osnova-desktop/README.md",
    "../osnova-docs/README.md",
    "../osnova-plugin-sdk/README.md",
    "../osnova-plugins/README.md",
    "../osnova-runtime/README.md",
    "README.md"
  ];
  const requiredSections = config.requiredReadmeSections ?? [
    "Статус",
    "Stack",
    "Команды",
    "Границы",
    "Связанные репозитории",
    "Лицензия"
  ];
  for (const configuredPath of readmes) {
    const filePath = resolveConfigPath(config, typeof configuredPath === "string" ? configuredPath : configuredPath.path);
    let sourceText;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch {
      addIssue(failures, "D5", filePath, "README does not exist.");
      continue;
    }
    const headings = [...sourceText.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)].map((match) => normalizeHeading(match[1]));
    const missing = requiredSections.filter((section) => {
      const aliases = readmeSectionAliases[section] ?? [normalizeHeading(section)];
      return !headings.some((heading) => aliases.includes(heading));
    });
    if (missing.length > 0) addIssue(failures, "D5", filePath, `README is missing required H2 sections: ${missing.join(", ")}.`);
  }
}

async function checkD6({ config, failures }) {
  const buildConfig = config.docsBuild ?? { enabled: true, cwd: "../osnova-docs", command: "pnpm", args: ["build"] };
  if (buildConfig.enabled === false) return;
  const workingDirectory = resolveConfigPath(config, buildConfig.cwd ?? "../osnova-docs");
  const vitepressConfigPath = resolveConfigPath(config, buildConfig.config ?? "../osnova-docs/docs/.vitepress/config.ts");
  if (await pathExists(vitepressConfigPath)) {
    const vitepressConfig = await readFile(vitepressConfigPath, "utf8");
    const ignoreDeadLinks = vitepressConfig.match(/\bignoreDeadLinks\s*:\s*([^,}\n]+)/u)?.[1]?.trim();
    if (ignoreDeadLinks && ignoreDeadLinks !== "false") {
      addIssue(failures, "D6", vitepressConfigPath, "VitePress must keep ignoreDeadLinks: false or omit it to use the default.");
      return;
    }
  } else {
    addIssue(failures, "D6", vitepressConfigPath, "VitePress configuration does not exist.");
    return;
  }

  const configuredCommand = buildConfig.command ?? "pnpm";
  const command = process.platform === "win32" && configuredCommand === "pnpm" ? "pnpm.cmd" : configuredCommand;
  try {
    await execFileAsync(command, buildConfig.args ?? ["build"], {
      cwd: workingDirectory,
      timeout: Number(buildConfig.timeoutMs ?? 180_000),
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: "true" }
    });
  } catch (error) {
    addIssue(failures, "D6", workingDirectory, `VitePress production build failed: ${commandError(error)}`);
  }
}

async function checkD7({ config, warnings }) {
  const mappings = normalizeDocMap(config.docMap ?? config.documentationMap ?? {});
  const docsRoot = resolveConfigPath(config, config.docsRoot ?? "../osnova-docs/docs");
  for (const mapping of mappings) {
    const modulePath = resolveConfigPath(config, mapping.module);
    const pagePath = path.isAbsolute(mapping.page) ? mapping.page : path.join(docsRoot, mapping.page);
    if (!(await pathExists(modulePath))) {
      addIssue(warnings, "D7", modulePath, `Mapped code module is missing; review the documentation map (${mapping.page}).`, 0, "", "warn");
    }
    if (!(await pathExists(pagePath))) {
      addIssue(warnings, "D7", pagePath, `Mapped documentation page is missing for ${mapping.module}.`, 0, "", "warn");
    }
  }
}

function normalizeDocMap(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry.module === "string" && typeof entry.page === "string");
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([module, page]) => ({ module, page })).filter((entry) => typeof entry.page === "string");
}

async function readFrontmatter(filePath, failures) {
  let sourceText;
  try {
    sourceText = await readFile(filePath, "utf8");
  } catch {
    addIssue(failures, "D2", filePath, "Documentation page cannot be read.");
    return null;
  }
  try {
    const parsed = parseFrontmatter(sourceText);
    if (!parsed) {
      addIssue(failures, "D2", filePath, "Every documentation page must start with a YAML frontmatter block.");
      return null;
    }
    if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
      addIssue(failures, "D2", filePath, "YAML frontmatter must contain a mapping.", parsed.startOffset, sourceText);
      return null;
    }
    return parsed;
  } catch (error) {
    addIssue(failures, "D2", filePath, `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function parseFrontmatter(sourceText) {
  const text = sourceText.startsWith("\uFEFF") ? sourceText.slice(1) : sourceText;
  if (!/^---[ \t]*(?:\r?\n|$)/u.test(text)) return null;
  const openingEnd = text.indexOf("\n") >= 0 ? text.indexOf("\n") + 1 : text.length;
  const closingPattern = /^---[ \t]*(?:\r?\n|$)/gmu;
  closingPattern.lastIndex = openingEnd;
  const closing = closingPattern.exec(text);
  if (!closing) throw new Error("Frontmatter closing delimiter --- is missing.");
  const yamlText = text.slice(openingEnd, closing.index);
  const data = yaml.load(yamlText);
  return { data, yamlText, startOffset: 0, endOffset: closing.index + closing[0].length };
}

function validateAxis(failures, filePath, data, field, allowedValues) {
  if (typeof data[field] !== "string" || !allowedValues.includes(data[field])) {
    addIssue(failures, "D2", filePath, `${field} must be one of ${allowedValues.join(", ")}.`);
  }
}

function validateAdrFrontmatter(failures, filePath, data) {
  const statuses = ["accepted", "superseded", "rejected"];
  if (typeof data.adrStatus !== "string" || !statuses.includes(data.adrStatus)) {
    addIssue(failures, "D2", filePath, `adrStatus must be one of ${statuses.join(", ")}.`);
  }
  const hasSupersededBy = Object.prototype.hasOwnProperty.call(data, "supersededBy");
  if (data.adrStatus === "superseded") {
    if (!hasSupersededBy || !Number.isInteger(data.supersededBy) || data.supersededBy < 1) {
      addIssue(failures, "D2", filePath, "Superseded ADRs require a positive integer supersededBy.");
    }
  } else if (hasSupersededBy) {
    addIssue(failures, "D2", filePath, "supersededBy is allowed only when adrStatus is superseded.");
  }
}

function findProjectFormatVersions(node, result = []) {
  if (Array.isArray(node)) {
    for (const item of node) findProjectFormatVersions(item, result);
    return result;
  }
  if (!node || typeof node !== "object") return result;
  if (node.title === "ProjectFormatVersion" && Array.isArray(node.enum)) {
    for (const version of node.enum) if (typeof version === "string") result.push(version);
  }
  for (const value of Object.values(node)) findProjectFormatVersions(value, result);
  return [...new Set(result)];
}

function extractVersionLiterals(sourceText) {
  const versions = new Set();
  for (const match of sourceText.matchAll(/(["'`])(\d+\.\d+)\1/gu)) versions.add(match[2]);
  return [...versions];
}

function maxVersion(versions) {
  return [...versions].sort((left, right) => compareVersions(left, right)).at(-1);
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function extractMermaidBlocks(sourceText) {
  const lines = sourceText.split(/(?<=\n)/u);
  const blocks = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r?\n$/u, "");
    const opening = line.match(mermaidOpeningPattern);
    if (!opening) {
      offset += lines[index].length;
      continue;
    }
    const fence = opening[1];
    const bodyStart = offset + lines[index].length;
    let cursor = bodyStart;
    let closingIndex = -1;
    let closingOffset = bodyStart;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].replace(/\r?\n$/u, "");
      const closingPattern = new RegExp(`^ {0,3}${escapeRegExp(fence[0])}{${fence.length},}[ \\t]*$`, "u");
      if (closingPattern.test(candidate)) {
        closingIndex = next;
        closingOffset = cursor;
        break;
      }
      cursor += lines[next].length;
    }
    if (closingIndex < 0) {
      blocks.push({ body: sourceText.slice(bodyStart), startOffset: offset, endOffset: sourceText.length, unclosed: true });
      break;
    }
    blocks.push({
      body: sourceText.slice(bodyStart, closingOffset),
      startOffset: offset,
      endOffset: closingOffset + lines[closingIndex].length,
      unclosed: false
    });
    for (let consumed = index; consumed <= closingIndex; consumed += 1) offset += lines[consumed].length;
    index = closingIndex;
  }
  return blocks;
}

function extractCodeComments(filePath, sourceText) {
  const extension = path.extname(filePath).toLowerCase();
  if (!codeExtensions.has(extension) || filePath.endsWith(".d.ts")) return [];
  const scriptKind = extension === ".tsx" || extension === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, sourceText);
  const comments = [];
  let tokenKind;
  while ((tokenKind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (tokenKind === ts.SyntaxKind.SingleLineCommentTrivia || tokenKind === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({ text: sourceText.slice(scanner.getTokenPos(), scanner.getTextPos()), pos: scanner.getTokenPos(), end: scanner.getTextPos() });
    }
  }
  return comments;
}

function extractDocReferences(commentText) {
  const references = [];
  const pattern = /\bosnova-docs\/[^\s`"'<>]+/gu;
  for (const match of commentText.matchAll(pattern)) references.push({ value: match[0], offset: match.index });
  return references;
}

function normalizeDocReference(value) {
  const clean = value.replace(/[),.;:!?]+$/u, "").split(/[?#]/u, 1)[0];
  if (!clean.startsWith("osnova-docs/") || clean.includes("\\")) return null;
  const normalized = path.posix.normalize(clean);
  if (normalized !== clean || normalized.includes("../") || normalized === "osnova-docs") return null;
  return normalized;
}

async function scanCodeArrowReferences({ config } = {}) {
  const failures = [];
  await checkD1({ config: config ?? {}, failures });
  return failures;
}

async function readJsonOrIssue(filePath, failures, rule) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    addIssue(failures, rule, filePath, `Configuration file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function collectMarkdownFiles(directoryPath) {
  const files = [];
  for (const entry of await readdir(directoryPath, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !excludedDirectoryNames.has(entry.name)) {
      files.push(...await collectMarkdownFiles(path.join(directoryPath, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.join(directoryPath, entry.name));
    }
  }
  return files.sort();
}

async function collectCodeFiles(targetPath) {
  const target = await stat(targetPath).catch(() => null);
  if (!target) return [];
  if (target.isFile()) return codeExtensions.has(path.extname(targetPath).toLowerCase()) && !targetPath.endsWith(".d.ts") ? [targetPath] : [];
  if (!target.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && !excludedDirectoryNames.has(entry.name)) files.push(...await collectCodeFiles(path.join(targetPath, entry.name)));
    else if (entry.isFile() && codeExtensions.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith(".d.ts")) files.push(path.join(targetPath, entry.name));
  }
  return files;
}

async function expandConfiguredPath(configuredPath, config = {}) {
  const absolutePath = resolveConfigPath(config, configuredPath);
  if (!/[\*\?\[]/u.test(absolutePath)) return (await pathExists(absolutePath)) ? [absolutePath] : [];
  const segments = absolutePath.split(path.sep);
  const firstPatternIndex = segments.findIndex((segment) => /[\*\?\[]/u.test(segment));
  const basePath = segments.slice(0, firstPatternIndex).join(path.sep) || path.parse(absolutePath).root;
  return expandSegments(basePath, segments.slice(firstPatternIndex));
}

async function expandSegments(currentPath, segments) {
  if (segments.length === 0) return [currentPath];
  const [segment, ...rest] = segments;
  if (segment === "**") {
    const direct = await expandSegments(currentPath, rest);
    const nested = (await readdir(currentPath, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !excludedDirectoryNames.has(entry.name));
    const descendants = (await Promise.all(nested.map((entry) => expandSegments(path.join(currentPath, entry.name), segments)))).flat();
    return [...direct, ...descendants];
  }
  const matcher = new RegExp(`^${segment.replace(/[.+^${}()|\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.filter((entry) => matcher.test(entry.name) && !excludedDirectoryNames.has(entry.name)).map((entry) => expandSegments(path.join(currentPath, entry.name), rest)))).flat();
}

function resolveConfigPath(config, configuredPath) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) return path.join(specRoot, "<missing-path>");
  if (path.isAbsolute(configuredPath)) return path.normalize(configuredPath);
  const base = config.pathBase === "config" ? path.dirname(config._configPath ?? defaultConfigPath) : specRoot;
  return path.resolve(base, configuredPath);
}

function resolveSpecPath(configuredPath) {
  if (path.isAbsolute(configuredPath)) return path.normalize(configuredPath);
  return path.resolve(specRoot, configuredPath);
}

function isInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function pathExists(filePath) {
  return Boolean(await stat(filePath).catch(() => null));
}

function normalizeHeading(value) {
  return String(value).trim().replace(/[\s#]+$/gu, "").toLocaleLowerCase("ru-RU");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function addIssue(collection, rule, filePath, message, offset = 0, sourceText = "", severity = "error") {
  const location = sourceText ? lineAndColumn(sourceText, offset) : { line: 1, column: 1 };
  collection.push({ rule, filePath, line: location.line, column: location.column, message, severity });
}

function lineAndColumn(sourceText, offset) {
  const safeOffset = Math.max(0, Math.min(offset, sourceText.length));
  const before = sourceText.slice(0, safeOffset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: safeOffset - lineStart + 1 };
}

function compareIssues(left, right) {
  return left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule);
}

function commandError(error) {
  const output = [error?.shortMessage, error?.stderr, error?.stdout, error?.message].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  return output.slice(0, 800) || "unknown command error";
}

function printResult(result, asJson = false) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const warning of result.warnings) process.stdout.write(`${formatIssue(warning)}\n`);
  for (const failure of result.failures) process.stdout.write(`${formatIssue(failure)}\n`);
  if (result.failures.length === 0) {
    process.stdout.write(`Documentation checks passed (${result.rules.join(", ")}).\n`);
  } else {
    process.stdout.write(`Documentation checks failed: ${result.failures.length} error${result.failures.length === 1 ? "" : "s"}.\n`);
  }
}

function formatIssue(issue) {
  const relativePath = path.relative(process.cwd(), issue.filePath) || path.basename(issue.filePath);
  return `${relativePath}:${issue.line}:${issue.column} [${issue.rule}] ${issue.message}`;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
