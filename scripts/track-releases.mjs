#!/usr/bin/env node
// Finds GitHub Releases of listed plugins that are not in the index yet and
// adds them as new versions. The scheduled `track-releases` workflow runs this
// once per scope and opens one pull request per scope: `organization` covers
// plugins whose repository belongs to the Lithe-IDEA organization and is merged
// by the workflow after the archives are verified; `external` covers every other
// plugin and waits for a maintainer review.
//
// Public repositories of the Lithe-IDEA organization whose names start with
// `lithe-plugin-` are tracked before they are listed: once such a repository
// publishes a stable release, the tracker adds a new entry for it, drafted from
// the repository's metadata and the package's plugin.json. `lithe-plugin-docs`
// carries the prefix but is not a plugin, so it is excluded.
//
// Release convention (see docs/publishing.md):
//   - a published, non-prerelease GitHub Release in the plugin's `repository`;
//   - one `.zip` asset per platform named `<anything>-<os>-<arch>.zip`
//     (for example `zig-support-2.0.0-darwin-arm64.zip`), or `<anything>-<os>.zip`
//     for one archive that serves every architecture of that OS;
//   - every archive agrees on plugin.json `version`, `pluginAPIVersion`, and `requires`.
//
// Usage: node scripts/track-releases.mjs [index.json] [--scope organization|external] [--plugin <id>] [--dry-run]
// Without `--scope` every plugin is tracked. `--plugin` accepts the ID of a
// listed plugin or of an unlisted organization plugin.
// GITHUB_TOKEN is used for API requests when set.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkManifest, formatIndex, readArchiveBytes, requirementsKey, validateIndex } from "./validate-index.mjs";

export const DISCOVERY_OWNER = "Lithe-IDEA";
export const DISCOVERY_PREFIX = "lithe-plugin-";
// Organization repositories that carry the prefix but do not publish a plugin.
export const DISCOVERY_EXCLUDED = new Set(["lithe-plugin-docs"]);
export const SCOPES = ["organization", "external"];

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

/** True when the plugin's repository belongs to the Lithe-IDEA organization. */
export function isOrganizationEntry(entry) {
  const [owner] = repositoryPath(entry.repository).split("/");
  return owner.toLowerCase() === DISCOVERY_OWNER.toLowerCase();
}

/** Whether a run limited to `scope` tracks the entry. A run without a scope tracks every entry. */
export function inScope(entry, scope) {
  if (scope === undefined) return true;
  return isOrganizationEntry(entry) === (scope === "organization");
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

/** Builds a version; injected archive I/O keeps unit tests independent of network and unzip. */
export async function versionFromRelease(entry, release, {
  downloadArchive = download, readManifests = readArchiveBytes,
} = {}) {
  const problems = [];
  const downloads = [];
  const versions = new Set();
  const apiVersions = new Set();
  const capabilityRequirements = new Map();
  const claimed = new Set();
  for (const asset of release.assets ?? []) {
    const platforms = platformsForAsset(asset.name);
    if (!platforms) continue;
    if (platforms.some((platform) => claimed.has(platform))) {
      problems.push(`${asset.name}: a platform is already served by another asset`);
      continue;
    }
    try {
      const bytes = await downloadArchive(asset.browser_download_url);
      const { manifests, unsafe } = readManifests(bytes, entry.id);
      const assetProblems = [...unsafe.map((name) => `unsafe path ${name}`), ...checkManifest(manifests, entry)];
      if (assetProblems.length > 0) {
        problems.push(...assetProblems.map((problem) => `${asset.name}: ${problem}`));
        continue;
      }
      versions.add(manifests[0].version);
      apiVersions.add(manifests[0].pluginAPIVersion);
      capabilityRequirements.set(requirementsKey(manifests[0].requires), manifests[0].requires);
      platforms.forEach((platform) => claimed.add(platform));
      downloads.push({
        platforms,
        downloadURL: asset.browser_download_url,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      problems.push(`${asset.name}: ${error.message}`);
    }
  }
  if (downloads.length === 0) problems.push("no `<name>-<os>[-<arch>].zip` plugin archive in this release");
  if (versions.size > 1) problems.push(`archives disagree on plugin.json version: ${[...versions].join(", ")}`);
  if (apiVersions.size > 1) problems.push(`archives disagree on pluginAPIVersion: ${[...apiVersions].join(", ")}`);
  if (capabilityRequirements.size > 1) problems.push("archives disagree on plugin.json requires");
  if (problems.length > 0) return { problems };
  const requires = capabilityRequirements.values().next().value;
  const version = {
    version: [...versions][0],
    pluginAPIVersion: [...apiVersions][0],
    requires: Object.fromEntries(Object.keys(requires).sort().map((id) => [id, requires[id]])),
    releaseDate: (release.published_at ?? release.created_at).slice(0, 10),
    downloads: downloads.sort((left, right) => left.platforms[0].localeCompare(right.platforms[0])),
  };
  // Refuse an invalid release before it can affect other plugins' tracked updates.
  const versionProblems = validateIndex({ schemaVersion: 0, plugins: [{ ...entry, versions: [version] }] });
  return versionProblems.length > 0 ? { problems: versionProblems } : { version };
}

/**
 * Adds every stable release that the entry does not list yet, newest first.
 * Returns the added versions and, with their reasons, the releases it refused.
 */
export async function trackEntry(entry, releases, archiveIO = {}) {
  const added = [];
  const skipped = [];
  const listed = new Set(entry.versions.map((version) => version.version));
  const listedURLs = new Set(entry.versions.flatMap((version) => version.downloads.map((d) => d.downloadURL)));
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    if ((release.assets ?? []).some((asset) => listedURLs.has(asset.browser_download_url))) continue;
    const result = await versionFromRelease(entry, release, archiveIO);
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
  return { added, skipped };
}

/** Selects the organization repositories that should be listed but are not yet. */
export function unlistedPluginRepositories(repositories, index) {
  const listed = new Set(index.plugins.map((entry) => repositoryPath(entry.repository).toLowerCase()));
  return repositories.filter((repository) =>
    repository.name.startsWith(DISCOVERY_PREFIX)
    && !DISCOVERY_EXCLUDED.has(repository.name)
    && !repository.private && !repository.archived && !repository.fork
    && !listed.has(repository.full_name.toLowerCase()));
}

/**
 * Drafts the index entry of an unlisted repository from its newest stable
 * release. plugin.json supplies the ID, name and author; the repository
 * supplies the description, license and topics as tags. The draft has no
 * versions: trackEntry adds them, so an entry is only listed with a valid release.
 */
export async function entryFromRepository(repository, releases, {
  downloadArchive = download, readManifests = readArchiveBytes,
} = {}) {
  const release = releases.find((candidate) => !candidate.draft && !candidate.prerelease
    && (candidate.assets ?? []).some((asset) => platformsForAsset(asset.name)));
  if (!release) return { problems: ["no stable release with a plugin archive yet"] };

  const license = repository.license?.spdx_id;
  const problems = [];
  if (!repository.description?.trim()) problems.push("the repository has no description");
  if (!license || license === "NOASSERTION") problems.push("GitHub detects no license in the repository");
  if (problems.length > 0) return { problems };

  const asset = release.assets.find((candidate) => platformsForAsset(candidate.name));
  let manifests;
  try {
    ({ manifests } = readManifests(await downloadArchive(asset.browser_download_url)));
  } catch (error) {
    return { problems: [`${release.tag_name} ${asset.name}: ${error.message}`] };
  }
  if (manifests.length !== 1) {
    return { problems: [`${release.tag_name} ${asset.name}: archive must contain exactly one plugin.json (found ${manifests.length})`] };
  }
  const [manifest] = manifests;
  // Field order follows the index schema, so the formatted diff reads like a hand-written entry.
  const entry = {
    id: manifest.id,
    name: manifest.displayName,
    author: manifest.vendor?.displayName,
    repository: repository.html_url,
    homepage: `${repository.html_url}#readme`,
    description: repository.description.trim(),
    ...(repository.topics?.length > 0 ? { tags: [...repository.topics] } : {}),
    license,
    versions: [],
  };
  return { entry };
}

/** Inserts an entry and keeps `plugins` sorted by id, as the store policy requires. */
export function insertEntry(index, entry) {
  index.plugins = [...index.plugins, entry].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Reads each URL once: drafting an entry and tracking its release use the same archive. */
function downloadOnce(downloadArchive) {
  const archives = new Map();
  return (url) => {
    if (!archives.has(url)) archives.set(url, downloadArchive(url));
    return archives.get(url);
  };
}

async function organizationRepositories(owner, request) {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(`orgs/${owner}/repos?type=public&per_page=100&page=${page}`);
    repositories.push(...batch);
    if (batch.length < 100) return repositories;
  }
}

/**
 * Lists the stable releases of organization plugin repositories that the index
 * does not hold yet. `onlyPlugin` keeps just the plugin with that ID. GitHub
 * and archive I/O are injectable so tests run without the network.
 */
export async function discoverPlugins(index, {
  onlyPlugin, request = github, downloadArchive = download, readManifests = readArchiveBytes,
} = {}) {
  const added = [];
  const skipped = [];
  const newPlugins = [];
  let repositories;
  try {
    repositories = await organizationRepositories(DISCOVERY_OWNER, request);
  } catch (error) {
    return { added, skipped: [`${DISCOVERY_OWNER} repositories: ${error.message}`], newPlugins };
  }
  for (const repository of unlistedPluginRepositories(repositories, index)) {
    let releases;
    try {
      releases = await request(`repos/${repository.full_name}/releases?per_page=20`);
    } catch (error) {
      skipped.push(`${repository.full_name}: ${error.message}`);
      continue;
    }
    const archiveIO = { downloadArchive: downloadOnce(downloadArchive), readManifests };
    const draft = await entryFromRepository(repository, releases, archiveIO);
    if (draft.problems) {
      skipped.push(`${repository.full_name}: ${draft.problems.join("; ")}`);
      continue;
    }
    const { entry } = draft;
    if (onlyPlugin && entry.id !== onlyPlugin) continue;
    const owner = index.plugins.find((listed) => listed.id === entry.id);
    if (owner) {
      skipped.push(`${repository.full_name}: ${entry.id} is already listed for ${owner.repository}`);
      continue;
    }
    const result = await trackEntry(entry, releases, archiveIO);
    skipped.push(...result.skipped);
    if (entry.versions.length === 0) continue;
    insertEntry(index, entry);
    added.push(...result.added.map((line) => `${line} [new plugin]`));
    newPlugins.push(entry.id);
  }
  return { added, skipped, newPlugins };
}

/**
 * Tracks the listed plugins of `scope` and, unless the scope is `external`,
 * discovers unlisted organization plugins. Discovered repositories belong to
 * the Lithe-IDEA organization, so they always fall in the `organization` scope.
 */
export async function trackIndex(index, {
  scope, onlyPlugin, request = github, downloadArchive, readManifests,
} = {}) {
  const added = [];
  const skipped = [];
  for (const entry of index.plugins) {
    if (!inScope(entry, scope) || (onlyPlugin && entry.id !== onlyPlugin)) continue;
    let releases;
    try {
      releases = await request(`repos/${repositoryPath(entry.repository)}/releases?per_page=20`);
    } catch (error) {
      skipped.push(`${entry.id}: ${error.message}`);
      continue;
    }
    const result = await trackEntry(entry, releases, { downloadArchive, readManifests });
    added.push(...result.added);
    skipped.push(...result.skipped);
  }
  if (scope === "external") return { added, skipped, newPlugins: [] };

  const discovered = await discoverPlugins(index, { onlyPlugin, request, downloadArchive, readManifests });
  return { added: [...added, ...discovered.added], skipped: [...skipped, ...discovered.skipped], newPlugins: discovered.newPlugins };
}

function flagValue(argv, flag) {
  const position = argv.indexOf(flag);
  return position >= 0 ? argv[position + 1] : undefined;
}

async function main(argv) {
  const onlyPlugin = flagValue(argv, "--plugin");
  const scope = flagValue(argv, "--scope");
  if (scope !== undefined && !SCOPES.includes(scope)) {
    console.error(`--scope must be one of: ${SCOPES.join(", ")}`);
    return 2;
  }
  const dryRun = argv.includes("--dry-run");
  const valueFlags = new Set(["--plugin", "--scope"]);
  const indexPath = argv.find((arg, position) => !arg.startsWith("--") && !valueFlags.has(argv[position - 1]))
    ?? "lithe-plugin-index.json";
  const index = JSON.parse(readFileSync(indexPath, "utf8"));

  const { added, skipped, newPlugins } = await trackIndex(index, { scope, onlyPlugin });

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
    const output = `added=${added.length}\nsummary=${summary}\nnew_plugins=${newPlugins.join(", ")}\n`;
    writeFileSync(process.env.GITHUB_OUTPUT, output, { flag: "a" });
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
