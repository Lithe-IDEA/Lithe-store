#!/usr/bin/env node
// Validates lithe-plugin-index.json against the Lithe plugin contract v1
// (https://github.com/1lck/Lithe-IDEA/tree/preview/shared/contracts/plugins/v1).
//
// Lithe's Rust Core (`plugins.marketplace.validateIndex`) is the source of truth
// and silently drops invalid entries. This store is stricter: any entry that
// Lithe would drop fails CI, so a merged index never hides a broken listing.
//
// Usage:
//   node scripts/validate-index.mjs [index.json]
//   node scripts/validate-index.mjs [index.json] --write-format
//   node scripts/validate-index.mjs [index.json] --verify-archives [--base <old-index.json>]
//
// --verify-archives downloads every archive (or, with --base, only archives
// whose URL, checksum, or expected manifest metadata changed), checks its SHA-256,
// and checks the plugin.json inside matches the index entry and is a community package.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_FIELDS = new Set([
  "id", "name", "author", "repository", "homepage", "description",
  "localizedDescriptions", "tags", "license", "icon", "versions",
]);
const VERSION_FIELDS = new Set(["version", "pluginAPIVersion", "requires", "releaseDate", "downloads"]);
const DOWNLOAD_FIELDS = new Set(["platforms", "downloadURL", "sha256"]);
const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/?$/;
const DOWNLOAD_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/[^/]+\/[^/]+\.zip$/;
const ICON_URL = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/.+/;
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export class IndexError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const invalid = (message) => new IndexError("plugin.index.invalid", message);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireText(entry, field) {
  if (typeof entry[field] !== "string" || entry[field].trim() === "") {
    throw invalid(`\`${field}\` must be a non-empty string`);
  }
}

function rejectUnknownFields(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw invalid(`unknown field \`${key}\` in ${where}`);
  }
}

function sameRepository(owner, repo, expected) {
  return owner.toLowerCase() === expected.owner && repo.toLowerCase() === expected.repo;
}

function isCalendarDate(text) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** Validates the index-level API and capability shape, without deciding host support. */
function validateVersionRequirements(version) {
  if (!Number.isInteger(version.pluginAPIVersion) || version.pluginAPIVersion < 1) {
    throw invalid("`pluginAPIVersion` must be a positive integer");
  }
  const present = Object.hasOwn(version, "requires");
  if (version.pluginAPIVersion < 3 && present) {
    throw invalid("`requires` is forbidden below pluginAPIVersion 3");
  }
  if (version.pluginAPIVersion === 3 && !present) {
    throw invalid("pluginAPIVersion 3 must list its capabilities in `requires`");
  }
  // Core permits API levels above 3 without requires, but validates it when supplied.
  if (!present) return;
  if (!isObject(version.requires) || Object.keys(version.requires).length === 0) {
    throw invalid("`requires` must be a non-empty capability object");
  }
  for (const [id, capabilityVersion] of Object.entries(version.requires)) {
    if (id.length > 64 || !/^[a-z][A-Za-z0-9]*$/.test(id)) {
      throw invalid(`malformed capability ID \`${id}\` in requires`);
    }
    if (!Number.isInteger(capabilityVersion) || capabilityVersion < 1) {
      throw invalid(`\`requires.${id}\` must be a positive integer`);
    }
  }
}

/** Stable equality key: capability-map property order has no contract meaning. */
export function requirementsKey(requires) {
  if (requires === undefined) return null;
  return JSON.stringify(Object.keys(requires).sort().map((id) => [id, requires[id]]));
}

/** Throws IndexError when Lithe would reject this entry from a third-party source. */
export function validateEntry(entry) {
  if (!isObject(entry)) throw invalid("plugin entry must be an object");
  rejectUnknownFields(entry, ENTRY_FIELDS, "plugin entry");

  if (typeof entry.id !== "string" || !/^[a-z0-9.-]+$/.test(entry.id)) {
    throw invalid("`id` must match ^[a-z0-9.-]+$");
  }
  if (entry.id === "dev.lithe" || entry.id.startsWith("dev.lithe.")) {
    throw new IndexError("plugin.index.officialNamespace", `\`${entry.id}\` is in the official dev.lithe namespace`);
  }
  for (const field of ["name", "author", "description", "license"]) requireText(entry, field);

  const repository = typeof entry.repository === "string" ? REPOSITORY.exec(entry.repository) : null;
  if (!repository) throw invalid("`repository` must be https://github.com/<owner>/<repo>");
  const expected = { owner: repository[1].toLowerCase(), repo: repository[2].toLowerCase() };

  if (entry.homepage !== undefined) {
    let url;
    try {
      url = new URL(entry.homepage);
    } catch {
      throw invalid("`homepage` must be a URL");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw invalid("`homepage` must be https without credentials");
    }
  }

  if (entry.localizedDescriptions !== undefined) {
    if (!isObject(entry.localizedDescriptions)) throw invalid("`localizedDescriptions` must be an object");
    for (const [tag, text] of Object.entries(entry.localizedDescriptions)) {
      if (!LANGUAGE_TAG.test(tag)) throw invalid(`malformed language tag \`${tag}\``);
      if (typeof text !== "string" || text.trim() === "") throw invalid(`empty description for \`${tag}\``);
    }
  }

  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string" || !/^\S+$/.test(tag))) {
      throw invalid("`tags` must be single words");
    }
  }

  if (entry.icon !== undefined) {
    const icon = typeof entry.icon === "string" ? ICON_URL.exec(entry.icon) : null;
    if (!icon || !sameRepository(icon[1], icon[2], expected)) {
      throw invalid("`icon` must be a raw.githubusercontent.com file of the plugin repository");
    }
  }

  if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
    throw invalid("`versions` must list at least one version");
  }
  const seenVersions = new Set();
  for (const version of entry.versions) {
    if (!isObject(version)) throw invalid("version must be an object");
    rejectUnknownFields(version, VERSION_FIELDS, "version");
    if (typeof version.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version.version)) {
      throw invalid("`version` must be MAJOR.MINOR.PATCH");
    }
    if (seenVersions.has(version.version)) throw invalid(`version ${version.version} is listed twice`);
    seenVersions.add(version.version);
    validateVersionRequirements(version);
    if (typeof version.releaseDate !== "string" || !isCalendarDate(version.releaseDate)) {
      throw invalid(`${version.version}: \`releaseDate\` must be a YYYY-MM-DD date`);
    }
    if (!Array.isArray(version.downloads) || version.downloads.length === 0) {
      throw invalid(`${version.version}: \`downloads\` must list at least one archive`);
    }
    const seenPlatforms = new Set();
    for (const download of version.downloads) {
      if (!isObject(download)) throw invalid(`${version.version}: download must be an object`);
      rejectUnknownFields(download, DOWNLOAD_FIELDS, "download");
      if (!Array.isArray(download.platforms) || download.platforms.length === 0) {
        throw invalid(`${version.version}: \`platforms\` must not be empty`);
      }
      for (const platform of download.platforms) {
        if (typeof platform !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(platform)) {
          throw invalid(`${version.version}: malformed platform \`${platform}\``);
        }
        if (seenPlatforms.has(platform)) throw invalid(`${version.version}: platform ${platform} has two archives`);
        seenPlatforms.add(platform);
      }
      const url = typeof download.downloadURL === "string" ? DOWNLOAD_URL.exec(download.downloadURL) : null;
      if (!url || !sameRepository(url[1], url[2], expected)) {
        throw invalid(`${version.version}: \`downloadURL\` must be a .zip release asset of ${entry.repository}`);
      }
      if (typeof download.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(download.sha256)) {
        throw invalid(`${version.version}: \`sha256\` must be 64 lowercase hex digits`);
      }
    }
  }
}

/**
 * Canonical index text: two-space indentation, arrays of plain values kept on
 * one line. The tracker writes this form and CI requires it, so bot and
 * hand-written pull requests produce the same minimal diffs.
 */
export function formatIndex(index) {
  const format = (value, indent) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      if (value.every((item) => item === null || typeof item !== "object")) {
        return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      }
      const inner = `${indent}  `;
      return `[\n${value.map((item) => inner + format(item, inner)).join(",\n")}\n${indent}]`;
    }
    if (value !== null && typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length === 0) return "{}";
      const inner = `${indent}  `;
      return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${format(value[key], inner)}`).join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return `${format(index, "")}\n`;
}

/** Returns a list of problems; an empty list means the index is publishable. */
export function validateIndex(index) {
  if (!isObject(index)) return ["index root must be an object"];
  const problems = [];
  for (const key of Object.keys(index)) {
    if (key !== "schemaVersion" && key !== "plugins") problems.push(`unknown root field \`${key}\``);
  }
  if (index.schemaVersion !== 1) problems.push("`schemaVersion` must be 1");
  if (!Array.isArray(index.plugins)) return [...problems, "`plugins` must be an array"];

  const seen = new Set();
  index.plugins.forEach((entry, position) => {
    const label = `plugins[${position}]${typeof entry?.id === "string" ? ` (${entry.id})` : ""}`;
    try {
      validateEntry(entry);
    } catch (error) {
      if (!(error instanceof IndexError)) throw error;
      problems.push(`${label}: ${error.code}: ${error.message}`);
      return;
    }
    if (seen.has(entry.id)) problems.push(`${label}: plugin.index.duplicate: id is already listed`);
    seen.add(entry.id);
  });

  // Store policy, stricter than Lithe: keep diffs reviewable and deterministic.
  const ids = index.plugins.map((entry) => entry?.id).filter((id) => typeof id === "string");
  const sorted = [...ids].sort();
  if (ids.some((id, position) => id !== sorted[position])) problems.push("store policy: `plugins` must be sorted by id");
  return problems;
}

export function listZipEntries(archive) {
  return execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

/** Returns every plugin.json in the archive whose id equals `pluginID`. */
export function readPackageManifests(archive, pluginID) {
  const names = listZipEntries(archive);
  const unsafe = names.filter((name) => name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."));
  const manifests = [];
  for (const name of names.filter((name) => name === "plugin.json" || name.endsWith("/plugin.json"))) {
    try {
      const manifest = JSON.parse(execFileSync("unzip", ["-p", archive, name], { encoding: "utf8" }));
      if (manifest?.id === pluginID) manifests.push(manifest);
    } catch {
      // Not a JSON manifest; Lithe ignores it the same way.
    }
  }
  return { manifests, unsafe };
}

/** Checks the package inside an archive is the community plugin it is listed as. */
export function checkManifest(manifests, entry, expected) {
  if (manifests.length !== 1) {
    return [`archive must contain exactly one plugin.json with id ${entry.id} (found ${manifests.length})`];
  }
  const [manifest] = manifests;
  const problems = [];
  if (manifest.id !== entry.id) {
    problems.push(`plugin.package.mismatch: plugin.json id ${manifest.id} != index ${entry.id}`);
  }
  try {
    validateVersionRequirements(manifest);
  } catch (error) {
    if (!(error instanceof IndexError)) throw error;
    problems.push(`plugin.json: ${error.message}`);
  }
  if (expected && manifest.version !== expected.version) {
    problems.push(`plugin.package.mismatch: plugin.json version ${manifest.version} != index ${expected.version}`);
  }
  if (expected && manifest.pluginAPIVersion !== expected.pluginAPIVersion) {
    problems.push(`plugin.json pluginAPIVersion ${manifest.pluginAPIVersion} != index ${expected.pluginAPIVersion}`);
  }
  if (expected && problems.length === 0 && requirementsKey(manifest.requires) !== requirementsKey(expected.requires)) {
    problems.push("plugin.json requires != index requires");
  }
  if (manifest.vendor?.signatureRequirement !== "none") {
    problems.push('community packages must declare vendor.signatureRequirement "none"');
  }
  return problems;
}

/** Checks one downloaded archive against its index entry and version. */
export function inspectArchive(archive, entry, version) {
  const { manifests, unsafe } = readPackageManifests(archive, entry.id);
  return [...unsafe.map((name) => `unsafe path in archive: ${name}`), ...checkManifest(manifests, entry, version)];
}

/** Reads package data without extracting or executing the archive's files. */
export function readArchiveBytes(bytes, pluginID) {
  const workDir = mkdtempSync(join(tmpdir(), "lithe-store-"));
  try {
    const archive = join(workDir, "plugin.zip");
    writeFileSync(archive, bytes);
    return readPackageManifests(archive, pluginID);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function downloadArchive(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function archiveVerificationKey(entry, version, download) {
  return JSON.stringify([
    entry.id, version.version, version.pluginAPIVersion, requirementsKey(version.requires),
    download.downloadURL, download.sha256,
  ]);
}

/** Dependencies let tests exercise checksum and manifest checks with in-memory archives. */
export async function verifyArchives(index, baseIndex, {
  download = downloadArchive, readManifests = readArchiveBytes, log = console.log,
} = {}) {
  const known = new Set();
  // An invalid old index cannot establish that a package was already checked.
  if (baseIndex && validateIndex(baseIndex).length === 0) {
    for (const entry of baseIndex.plugins) {
      for (const version of entry.versions) {
        for (const download of version.downloads) known.add(archiveVerificationKey(entry, version, download));
      }
    }
  }
  const problems = [];
  for (const entry of index.plugins) {
    for (const version of entry.versions) {
      for (const archiveDownload of version.downloads) {
        if (known.has(archiveVerificationKey(entry, version, archiveDownload))) continue;
        const label = `${entry.id}@${version.version} ${archiveDownload.downloadURL}`;
        try {
          const bytes = await download(archiveDownload.downloadURL);
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== archiveDownload.sha256) {
            problems.push(`${label}: plugin.archive.checksumMismatch: got ${digest}`);
            continue;
          }
          const { manifests, unsafe } = readManifests(bytes, entry.id);
          const archiveProblems = [
            ...unsafe.map((name) => `unsafe path in archive: ${name}`),
            ...checkManifest(manifests, entry, version),
          ];
          problems.push(...archiveProblems.map((problem) => `${label}: ${problem}`));
          if (archiveProblems.length === 0) log(`verified ${label}`);
        } catch (error) {
          problems.push(`${label}: ${error.message}`);
        }
      }
    }
  }
  return problems;
}

async function main(argv) {
  const args = [...argv];
  const verify = args.includes("--verify-archives");
  const baseFlag = args.indexOf("--base");
  const basePath = baseFlag >= 0 ? args[baseFlag + 1] : undefined;
  const indexPath = args.find((arg, position) => !arg.startsWith("--") && args[position - 1] !== "--base")
    ?? "lithe-plugin-index.json";

  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    console.error(`${indexPath}: ${error.message}`);
    return 1;
  }
  const problems = validateIndex(index);
  if (args.includes("--write-format")) {
    writeFileSync(indexPath, formatIndex(index));
  } else if (readFileSync(indexPath, "utf8") !== formatIndex(index)) {
    problems.push(`store policy: ${indexPath} is not canonically formatted; run node scripts/validate-index.mjs --write-format`);
  }
  if (problems.length === 0 && verify) {
    let baseIndex;
    if (basePath) {
      try {
        baseIndex = JSON.parse(readFileSync(basePath, "utf8"));
      } catch {
        baseIndex = undefined; // A missing or broken base index means every archive is new.
      }
    }
    problems.push(...(await verifyArchives(index, baseIndex)));
  }
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) return 1;
  console.log(`✓ ${indexPath}: ${index.plugins.length} plugin(s) valid`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
