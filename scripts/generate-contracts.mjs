import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compile } from "json-schema-to-typescript";

const root = path.resolve(import.meta.dirname, "..");
const coreRoot = path.resolve(option("--core") ?? path.join(root, "..", "osnova-core"));
const sdkRoot = path.resolve(option("--sdk") ?? path.join(root, "..", "osnova-plugin-sdk"));
const checkOnly = process.argv.includes("--check");

const BANNER = [
  "/**",
  " * Generated from the osnova-spec contract schemas (scripts/generate-contracts.mjs).",
  " * Do not edit by hand: change the schema and regenerate.",
  " */"
].join("\n");

// Core contract types: schema to interface name.
const coreContracts = [
  ["osnova", "OsnovaManifest"],
  ["artifact", "ArtifactDescriptor"],
  ["artifact-relation", "ArtifactRelation"],
  ["session", "SessionDescriptor"],
  ["session-event", "SessionEvent"],
  ["context-envelope", "ContextEnvelope"],
  ["agent-plan", "AgentPlan"],
  ["job", "JobDescriptor"]
];

// SDK contract types.
const sdkContracts = [
  ["extension-manifest", "ExtensionManifest"]
];

const generated = [];
for (const [schemaName, typeName] of [...coreContracts, ...sdkContracts]) {
  const isCore = coreContracts.some(([n]) => n === schemaName);
  const sourceRoot = isCore ? coreRoot : sdkRoot;
  const schemaPath = path.join(root, "schemas", `${schemaName}.schema.json`);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  schema.title = typeName;
  const output = await compile(schema, typeName, {
    name: typeName,
    bannerComment: BANNER,
    style: { semi: true, singleQuote: false, tabWidth: 2 },
    enableConstToObject: true
  });
  const relativeTarget = isCore
    ? path.join("packages", "types", "src", "generated", `${schemaName}.generated.ts`)
    : path.join("src", "generated", `${schemaName}.generated.ts`);
  const target = path.join(sourceRoot, relativeTarget);
  generated.push([target, output.trimEnd() + "\n"]);
}

if (checkOnly) {
  const drifted = [];
  for (const [target, content] of generated) {
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== content) drifted.push(path.relative(process.cwd(), target));
  }
  if (drifted.length > 0) {
    process.stderr.write(`Сгенерированные типы устарели, запусти npm run generate в osnova-spec:\n${drifted.map((p) => `  ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Проверено ${generated.length} сгенерированных контрактов: актуальны.\n`);
} else {
  for (const [target, content] of generated) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    process.stdout.write(`Записано ${path.relative(process.cwd(), target)}\n`);
  }
}

function option(name) {
  const index = process.argv.indexOf(`--${name.replace(/^--/, "")}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
