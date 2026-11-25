// Fails when the locale dictionaries do not have identical keys, or when a
// value is empty or not a string. Run in CI: npm run check:i18n
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../src/i18n/dictionaries");
const reference = "id";

function flatten(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const dictionaries = new Map(
  files.map((f) => [path.basename(f, ".json"), flatten(JSON.parse(readFileSync(path.join(dir, f), "utf8")))]),
);

if (!dictionaries.has(reference)) {
  console.error(`Missing reference dictionary ${reference}.json`);
  process.exit(1);
}

const problems = [];
const refKeys = new Set(dictionaries.get(reference).keys());

for (const [locale, entries] of dictionaries) {
  for (const key of refKeys) {
    if (!entries.has(key)) problems.push(`${locale}: missing "${key}"`);
  }
  for (const [key, value] of entries) {
    if (!refKeys.has(key)) problems.push(`${locale}: extra key "${key}" not in ${reference}.json`);
    if (typeof value !== "string" || value.trim() === "") problems.push(`${locale}: "${key}" is empty or not a string`);
  }
}

if (problems.length > 0) {
  console.error(`i18n check failed (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`i18n check passed: ${dictionaries.size} locales, ${refKeys.size} keys each.`);
