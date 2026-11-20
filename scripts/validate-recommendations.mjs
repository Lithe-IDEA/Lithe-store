#!/usr/bin/env node
// Validates lithe-plugin-recommendations.json against the Lithe plugin contract
// (plugin-recommendations.schema.json in Lithe-IDEA/Lithe-core-rust) and cross-checks
// every referenced pluginID and coveredBy entry against lithe-plugin-index.json.
//
// Usage:
//   node scripts/validate-recommendations.mjs [recommendations.json] [index.json]
//   node scripts/validate-recommendations.mjs [recommendations.json] [index.json] --write-format

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatIndex } from "./validate-index.mjs";

const ENTRY_FIELDS = new Set(["pluginID", "markers", "extensions", "coveredBy"]);
const PLUGIN_ID = /^[a-z0-9.-]+$/;
const EXTENSION = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidMarker(value) {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function validateStringList(entry, field, label, checkItem, message, problems) {
  if (!(field in entry)) return;
  const list = entry[field];
  if (!Array.isArray(list)) {
    problems.push(`${label}: plugin.recommendations.invalid: \`${field}\` must be an array`);
    return;
  }
  const seen = new Set();
  list.forEach((item, index) => {
    if (!checkItem(item)) {
      problems.push(`${label}.${field}[${index}]: plugin.recommendations.invalid: ${message}`);
      return;
    }
    if (seen.has(item)) {
      problems.push(`${label}.${field}[${index}]: plugin.recommendations.invalid: duplicate value \`${item}\``);
    }
    seen.add(item);
  });
  const sorted = [...list].filter((item) => typeof item === "string").sort();
  if (list.some((item, index) => item !== sorted[index])) {
    problems.push(`store policy: ${label}.${field} must be sorted`);
  }
}

/** Validates the recommendation catalog, optionally against an index's known plugin IDs. */
export function validateRecommendations(catalog, index = undefined) {
  if (!isObject(catalog)) return ["recommendations root must be an object"];
  const problems = [];
  for (const key of Object.keys(catalog)) {
    if (key !== "schemaVersion" && key !== "recommendations") {
      problems.push(`plugin.recommendations.invalid: unknown root field \`${key}\``);
    }
  }
  if (catalog.schemaVersion !== 0) {
    problems.push("plugin.recommendations.schemaUnsupported: `schemaVersion` must be 0");
  }
  if (!Array.isArray(catalog.recommendations)) {
    return [...problems, "plugin.recommendations.invalid: `recommendations` must be an array"];
  }

  let knownIDs = null;
  if (index !== undefined) {
    if (!isObject(index) || !Array.isArray(index.plugins)) {
      problems.push("index root must hold a `plugins` array");
    } else {
      knownIDs = new Set(index.plugins.map((plugin) => plugin?.id).filter((id) => typeof id === "string"));
    }
  }

  const seenIDs = new Set();
  const listedIDs = [];
  catalog.recommendations.forEach((entry, position) => {
    const label = `recommendations[${position}]${typeof entry?.pluginID === "string" ? ` (${entry.pluginID})` : ""}`;
    if (!isObject(entry)) {
      problems.push(`${label}: plugin.recommendations.invalid: entry must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) {
        problems.push(`${label}: plugin.recommendations.invalid: unknown field \`${key}\``);
      }
    }
    if (typeof entry.pluginID !== "string" || !PLUGIN_ID.test(entry.pluginID)) {
      problems.push(`${label}: plugin.recommendations.invalid: \`pluginID\` must match ^[a-z0-9.-]+$`);
    } else {
      listedIDs.push(entry.pluginID);
      if (seenIDs.has(entry.pluginID)) {
        problems.push(`${label}: plugin.recommendations.duplicate: pluginID is already listed`);
      }
      seenIDs.add(entry.pluginID);
      if (knownIDs && !knownIDs.has(entry.pluginID)) {
        problems.push(`${label}: store policy: unknown pluginID \`${entry.pluginID}\` is not in index`);
      }
    }

    validateStringList(
      entry,
      "markers",
      label,
      isValidMarker,
      "markers must be trimmed basenames without path separators",
      problems,
    );
    validateStringList(
      entry,
      "extensions",
      label,
      (item) => typeof item === "string" && EXTENSION.test(item),
      "extensions must match ^[a-z0-9][a-z0-9_-]{0,31}$",
      problems,
    );
    validateStringList(
      entry,
      "coveredBy",
      label,
      (item) => typeof item === "string" && PLUGIN_ID.test(item) && item !== entry.pluginID,
      "coveredBy entries must be distinct valid plugin IDs",
      problems,
    );

    if (Array.isArray(entry.coveredBy) && knownIDs) {
      entry.coveredBy.forEach((alternative, idx) => {
        if (typeof alternative === "string" && !knownIDs.has(alternative)) {
          problems.push(`${label}.coveredBy[${idx}]: store policy: unknown coveredBy ID \`${alternative}\` is not in index`);
        }
      });
    }

    const markerCount = Array.isArray(entry.markers) ? entry.markers.length : 0;
    const extensionCount = Array.isArray(entry.extensions) ? entry.extensions.length : 0;
    if (markerCount === 0 && extensionCount === 0) {
      problems.push(`${label}: plugin.recommendations.invalid: entry must declare at least one marker or extension`);
    }
  });

  const sortedIDs = [...listedIDs].sort();
  if (listedIDs.some((id, indexPos) => id !== sortedIDs[indexPos])) {
    problems.push("store policy: `recommendations` must be sorted by pluginID");
  }
  return problems;
}

async function main(argv) {
  const args = [...argv];
  const writeFormat = args.includes("--write-format");
  const files = args.filter((arg) => !arg.startsWith("--"));
  const recommendationsPath = files[0] ?? "lithe-plugin-recommendations.json";
  const indexPath = files[1] ?? "lithe-plugin-index.json";

  let catalog;
  let index;
  try {
    catalog = JSON.parse(readFileSync(recommendationsPath, "utf8"));
  } catch (error) {
    console.error(`${recommendationsPath}: ${error.message}`);
    return 1;
  }
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    console.error(`${indexPath}: ${error.message}`);
    return 1;
  }

  const problems = validateRecommendations(catalog, index);
  const formatted = formatIndex(catalog);
  if (writeFormat) {
    writeFileSync(recommendationsPath, formatted);
  } else if (readFileSync(recommendationsPath, "utf8") !== formatted) {
    problems.push(
      `store policy: ${recommendationsPath} is not canonically formatted; run node scripts/validate-recommendations.mjs ${recommendationsPath} ${indexPath} --write-format`,
    );
  }

  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) return 1;
  console.log(`✓ ${recommendationsPath}: ${catalog.recommendations.length} recommendation(s) valid`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
