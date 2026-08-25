import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// Контрактные типы генерируются из схем (scripts/generate-contracts.mjs),
// поэтому сверка schema <-> interface здесь больше не нужна.
// Остаются две проверки: локальность $ref и валидность golden-примеров.

const schemaFiles = (await readdir(path.join(root, "schemas"))).filter((fileName) => fileName.endsWith(".schema.json"));
for (const fileName of schemaFiles) {
  const schema = JSON.parse(await readFile(path.join(root, "schemas", fileName), "utf8"));
  verifyLocalRefs(schema, schema, fileName);
}

await validateExample("examples/reborn/osnova.json", "schemas/osnova.schema.json");
await validateExample("examples/reborn/sessions/first-session/session.json", "schemas/session.schema.json");
const eventSchema = JSON.parse(await readFile(path.join(root, "schemas", "session-event.schema.json"), "utf8"));
const eventLines = (await readFile(path.join(root, "examples", "reborn", "sessions", "first-session", "events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean);
for (const [index, line] of eventLines.entries()) validate(eventSchema, JSON.parse(line), eventSchema, `events.jsonl:${index + 1}`);

process.stdout.write(`Verified ${schemaFiles.length} contract schemas and the Reborn golden project.\n`);

async function validateExample(examplePath, schemaPath) {
  const [value, schema] = await Promise.all([
    readFile(path.join(root, examplePath), "utf8").then(JSON.parse),
    readFile(path.join(root, schemaPath), "utf8").then(JSON.parse)
  ]);
  validate(schema, value, schema, examplePath);
}

function validate(schema, value, rootSchema, pointer) {
  if (schema.$ref) return validate(resolveRef(rootSchema, schema.$ref), value, rootSchema, pointer);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) throw new Error(`${pointer}: const mismatch.`);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${pointer}: enum mismatch.`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${pointer}: expected object.`);
    for (const field of schema.required ?? []) if (!(field in value)) throw new Error(`${pointer}: missing ${field}.`);
    for (const [field, child] of Object.entries(schema.properties ?? {})) if (field in value) validate(child, value[field], rootSchema, `${pointer}.${field}`);
    if (schema.additionalProperties === false) for (const field of Object.keys(value)) if (!(field in (schema.properties ?? {}))) throw new Error(`${pointer}: unexpected ${field}.`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${pointer}: expected array.`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${pointer}: too few items.`);
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, rootSchema, `${pointer}[${index}]`));
  } else if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${pointer}: expected string.`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) throw new Error(`${pointer}: pattern mismatch.`);
  } else if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${pointer}: expected integer.`);
  else if (schema.type === "number" && typeof value !== "number") throw new Error(`${pointer}: expected number.`);
  else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${pointer}: expected boolean.`);
}

function verifyLocalRefs(node, rootSchema, label) {
  if (Array.isArray(node)) return node.forEach((item) => verifyLocalRefs(item, rootSchema, label));
  if (!node || typeof node !== "object") return;
  if (typeof node.$ref === "string") {
    if (!node.$ref.startsWith("#/")) throw new Error(`${label}: external $ref is forbidden (${node.$ref}).`);
    resolveRef(rootSchema, node.$ref);
  }
  for (const value of Object.values(node)) verifyLocalRefs(value, rootSchema, label);
}

function resolveRef(schema, reference) {
  let cursor = schema;
  for (const raw of reference.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) throw new Error(`Unresolved $ref: ${reference}`);
    cursor = cursor[key];
  }
  return cursor;
}
