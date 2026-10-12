#!/usr/bin/env node
// Finds GitHub Releases of listed plugins that are not in the index yet and
// adds them as new versions. The scheduled `track-releases` workflow runs this
// and opens a pull request; maintainers review it like any other index change.
//
// Release convention (see docs/publishing.md):
//   - a published, non-prerelease GitHub Release in the plugin's `repository`;
//   - one `.zip` asset per platform named `<anything>-<os>-<arch>.zip`
//     (for example `zig-support-2.0.0-darwin-arm64.zip`), or `<anything>-<os>.zip`
//     for one archive that serves every architecture of that OS;
//   - every archive contains the same plugin.json `version`.
//
// Usage: node scripts/track-releases.mjs [index.json] [--plugin <id>] [--dry-run]
// GITHUB_TOKEN is used for API requests when set.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, formatIndex, readPackageManifests, validateIndex } from "./validate-index.mjs";

export const KNOWN_ARCHITECTURES = { darwin: ["arm64", "x64"], windows: ["x64", "arm64"], linux: ["x64", "arm64"] };
const ASSET_PLATFORM = /-(darwin|windows|linux)(?:-(arm64|x64))?\.zip$/;

/** Maps a release asset name to the platforms it serves, or null when it is not a plugin archive. */
export function platformsForAsset(name) {
  const match = ASSET_PLATFORM.exec(name);
  if (!match) return null;
  const [, os, arch] = match;
  return arch ? [`${os}-${arch}`] : KNOWN_ARCHITECTURES[os].map((value) => `${os}-${value}`);
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let position = 0; position < 3; position += 1) {
    if (a[position] !== b[position]) return a[position] - b[position];
  }
  return 0;
}

/** Inserts a version entry and keeps versions newest first. */
export function addVersion(entry, version) {
  entry.versions = [...entry.versions.filter((existing) => existing.version !== version.version), version]
    .sort((left, right) => compareVersions(right.version, left.version));
  return entry;
}

function repositoryPath(repository) {
  const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(repository);
  return `${owner}/${repo}`;
}

async function github(path) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Builds an index version from one release, or returns problems explaining why it cannot be listed. */
async function versionFromRelease(entry, release) {
  const problems = [];
  const downloads = [];
  const versions = new Set();
  const apiVersions = new Set();
  const claimed = new Set();
  for (const asset of release.assets ?? []) {
    const platforms = platformsForAsset(asset.name);
    if (!platforms) continue;
    if (platforms.some((platform) => claimed.has(platform))) {
      problems.push(`${asset.name}: a platform is already served by another asset`);
      continue;
    }
    const workDir = mkdtempSync(join(tmpdir(), "lithe-track-"));
    try {
      const bytes = await download(asset.browser_download_url);
      const archive = join(workDir, "plugin.zip");
      writeFileSync(archive, bytes);
      const { manifests, unsafe } = readPackageManifests(archive, entry.id);
      const assetProblems = [...unsafe.map((name) => `unsafe path ${name}`), ...checkManifest(manifests, entry)];
      if (assetProblems.length > 0) {
        problems.push(...assetProblems.map((problem) => `${asset.name}: ${problem}`));
        continue;
      }
      versions.add(manifests[0].version);
      apiVersions.add(manifests[0].pluginAPIVersion);
      platforms.forEach((platform) => claimed.add(platform));
      downloads.push({
        platforms,
        downloadURL: asset.browser_download_url,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      problems.push(`${asset.name}: ${error.message}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  if (downloads.length === 0) problems.push("no `<name>-<os>[-<arch>].zip` plugin archive in this release");
  if (versions.size > 1) problems.push(`archives disagree on plugin.json version: ${[...versions].join(", ")}`);
  if (apiVersions.size > 1) problems.push(`archives disagree on pluginAPIVersion: ${[...apiVersions].join(", ")}`);
  if (problems.length > 0) return { problems };
  return {
    version: {
      version: [...versions][0],
      pluginAPIVersion: [...apiVersions][0],
      releaseDate: (release.published_at ?? release.created_at).slice(0, 10),
      downloads: downloads.sort((left, right) => left.platforms[0].localeCompare(right.platforms[0])),
    },
  };
}

async function main(argv) {
  const pluginFlag = argv.indexOf("--plugin");
  const onlyPlugin = pluginFlag >= 0 ? argv[pluginFlag + 1] : undefined;
  const dryRun = argv.includes("--dry-run");
  const indexPath = argv.find((arg, position) => !arg.startsWith("--") && argv[position - 1] !== "--plugin")
    ?? "lithe-plugin-index.json";
  const index = JSON.parse(readFileSync(indexPath, "utf8"));

  const added = [];
  const skipped = [];
  for (const entry of index.plugins) {
    if (onlyPlugin && entry.id !== onlyPlugin) continue;
    const listed = new Set(entry.versions.map((version) => version.version));
    const listedURLs = new Set(entry.versions.flatMap((version) => version.downloads.map((d) => d.downloadURL)));
    let releases;
    try {
      releases = await github(`repos/${repositoryPath(entry.repository)}/releases?per_page=20`);
    } catch (error) {
      skipped.push(`${entry.id}: ${error.message}`);
      continue;
    }
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      if ((release.assets ?? []).some((asset) => listedURLs.has(asset.browser_download_url))) continue;
      const result = await versionFromRelease(entry, release);
      if (result.problems) {
        skipped.push(`${entry.id} ${release.tag_name}: ${result.problems.join("; ")}`);
        continue;
      }
      if (listed.has(result.version.version)) {
        skipped.push(`${entry.id} ${release.tag_name}: version ${result.version.version} is already listed with other archives`);
        continue;
      }
      addVersion(entry, result.version);
      listed.add(result.version.version);
      added.push(`${entry.id}@${result.version.version} (${release.tag_name})`);
    }
  }

  const problems = validateIndex(index);
  for (const line of added) console.log(`+ ${line}`);
  for (const line of skipped) console.log(`! skipped ${line}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  if (!dryRun && added.length > 0) writeFileSync(indexPath, formatIndex(index));
  if (process.env.GITHUB_OUTPUT) {
    const summary = added.join(", ");
    writeFileSync(process.env.GITHUB_OUTPUT, `added=${added.length}\nsummary=${summary}\n`, { flag: "a" });
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
