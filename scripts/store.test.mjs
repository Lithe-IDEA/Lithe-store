import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { END, START, categoryOf, renderOverview, renderReadme, systemsOf, truncate } from "./render-readme.mjs";
import {
  addVersion, discoverPlugins, isOrganizationEntry, platformsForAsset, trackIndex, unlistedPluginRepositories,
  versionFromRelease,
} from "./track-releases.mjs";
import {
  checkManifest, formatIndex, inspectArchive, readPackageManifests, validateEntry, validateIndex, verifyArchives,
} from "./validate-index.mjs";

// Fixtures are copied from the plugin contract (lithe-plugin-docs contract/v1/fixtures/marketplace)
// so this validator reports the same code as Lithe's Rust Core for each case.
const fixtureIndex = JSON.parse(readFileSync(new URL("./fixtures/index.json", import.meta.url)));
const invalidCases = JSON.parse(readFileSync(new URL("./fixtures/invalid-index-entries.json", import.meta.url))).cases;
const validEntry = () => structuredClone(fixtureIndex.plugins[0]);

function applyEdits(entry, edits) {
  for (const { op, path, value } of edits) {
    const keys = path.split("/").slice(1);
    const last = keys.pop();
    const parent = keys.reduce((node, key) => node[key], entry);
    if (op === "remove") delete parent[last];
    else parent[last] = value;
  }
  return entry;
}

function codeOf(entry) {
  try {
    validateEntry(entry);
    return "ok";
  } catch (error) {
    return error.code;
  }
}

test("the fixture entry is a valid community listing", () => {
  assert.equal(codeOf(validEntry()), "ok");
});

for (const { name, edits, expectedCode } of invalidCases) {
  test(`rejects: ${name}`, () => {
    assert.equal(codeOf(applyEdits(validEntry(), edits)), expectedCode);
  });
}

function capabilityEntry() {
  const entry = validEntry();
  entry.versions = [entry.versions[1]];
  entry.versions[0].pluginAPIVersion = 3;
  entry.versions[0].requires = { buildSystems: 1 };
  return entry;
}

// Manifest fragments cover publishing metadata; Core owns full declarative validation.
function manifestFor(entry) {
  const version = entry.versions[0];
  return {
    schemaVersion: 2,
    id: entry.id,
    version: version.version,
    pluginAPIVersion: version.pluginAPIVersion,
    ...(Object.hasOwn(version, "requires") ? { requires: structuredClone(version.requires) } : {}),
    vendor: { signatureRequirement: "none" },
  };
}

// These bytes represent manifest data only. The injected reader never invokes unzip.
function releaseFixture(entry, manifests) {
  const assets = manifests.map((manifest, position) => ({
    name: `fixture-${position === 0 ? "darwin-arm64" : "windows-x64"}.zip`,
    browser_download_url: `${entry.repository}/releases/download/v2.0.0/fixture-${position === 0 ? "darwin-arm64" : "windows-x64"}.zip`,
    bytes: Buffer.from(JSON.stringify(manifest)),
  }));
  return {
    release: { published_at: "2026-10-18T00:00:00Z", assets },
    downloadArchive: async (url) => {
      const asset = assets.find((candidate) => candidate.browser_download_url === url);
      assert.ok(asset, `unexpected fixture download: ${url}`);
      return asset.bytes;
    },
    readManifests: (bytes, pluginID) => {
      assert.equal(pluginID, entry.id);
      return { manifests: [JSON.parse(bytes.toString())], unsafe: [] };
    },
  };
}

test("API 3 requires a non-empty capability map and accepts future capability IDs", () => {
  const entry = capabilityEntry();
  assert.equal(codeOf(entry), "ok");
  entry.versions[0].requires = { futureFeature: 99 };
  assert.equal(codeOf(entry), "ok");
  delete entry.versions[0].requires;
  assert.equal(codeOf(entry), "plugin.index.invalid");
  for (const requires of [null, {}, [], "buildSystems", { buildSystems: 0 }, { buildSystems: -1 },
    { buildSystems: 1.5 }, { buildSystems: "1" }, { buildSystems: true }, { "build-systems": 1 },
    { BuildSystems: 1 }, { "1buildSystems": 1 }, { ["a".repeat(65)]: 1 }]) {
    entry.versions[0].requires = requires;
    assert.equal(codeOf(entry), "plugin.index.invalid", JSON.stringify(requires));
  }
  entry.versions[0].requires = { ["a".repeat(64)]: 1 };
  assert.equal(codeOf(entry), "ok");
});

test("API 1/2 remain valid without requires and reject it when supplied", () => {
  for (const api of [1, 2]) {
    const entry = validEntry();
    entry.versions[0].pluginAPIVersion = api;
    assert.equal(codeOf(entry), "ok");
    for (const requires of [{ buildSystems: 1 }, null]) {
      entry.versions[0].requires = requires;
      assert.equal(codeOf(entry), "plugin.index.invalid");
    }
  }
});

test("future API levels may omit requires but validate a supplied map", () => {
  const entry = capabilityEntry();
  entry.versions[0].pluginAPIVersion = 4;
  delete entry.versions[0].requires;
  assert.equal(codeOf(entry), "ok");
  entry.versions[0].requires = { futureFeature: 1 };
  assert.equal(codeOf(entry), "ok");
  entry.versions[0].requires = {};
  assert.equal(codeOf(entry), "plugin.index.invalid");
});

test("package and index requirements agree regardless of key order", () => {
  const entry = capabilityEntry();
  const version = entry.versions[0];
  version.requires = { settings: 1, buildSystems: 1 };
  const manifest = { ...manifestFor(entry), requires: { buildSystems: 1, settings: 1 } };
  assert.deepEqual(checkManifest([manifest], entry, version), []);
  for (const requires of [{ buildSystems: 2, settings: 1 }, { buildSystems: 1 },
    { buildSystems: 1, settings: 1, futureFeature: 1 }]) {
    assert.match(checkManifest([{ ...manifest, requires }], entry, version).join(), /requires != index requires/);
  }
  delete manifest.requires;
  assert.match(checkManifest([manifest], entry, version).join(), /must list its capabilities/);
});

test("package checks retain identity, API and community trust checks", () => {
  const entry = capabilityEntry();
  const version = entry.versions[0];
  const manifest = manifestFor(entry);
  for (const [edit, expected] of [
    [{ id: "io.example.other" }, /plugin\.package\.mismatch/],
    [{ version: "9.0.0" }, /plugin\.package\.mismatch/],
    [{ pluginAPIVersion: 4 }, /pluginAPIVersion/],
    [{ vendor: { signatureRequirement: "publisherPackage" } }, /signatureRequirement/],
  ]) {
    assert.match(checkManifest([{ ...manifest, ...edit }], entry, version).join(), expected);
  }
  for (const api of [1, 2]) {
    const legacyEntry = validEntry();
    legacyEntry.versions[0].pluginAPIVersion = api;
    const legacyManifest = manifestFor(legacyEntry);
    assert.deepEqual(checkManifest([legacyManifest], legacyEntry, legacyEntry.versions[0]), []);
    assert.match(checkManifest([{ ...legacyManifest, requires: { languages: 1 } }], legacyEntry).join(), /forbidden/);
  }
});

test("release tracking copies API 3 requires and normalizes its key order", { timeout: 5_000 }, async () => {
  const entry = capabilityEntry();
  const manifest = { ...manifestFor(entry), requires: { settings: 1, buildSystems: 1 } };
  const fixture = releaseFixture(entry, [manifest, { ...manifest, requires: { buildSystems: 1, settings: 1 } }]);
  const result = await versionFromRelease(entry, fixture.release, fixture);
  assert.equal(result.problems, undefined);
  assert.deepEqual(result.version.requires, { buildSystems: 1, settings: 1 });
  assert.deepEqual(Object.keys(result.version.requires), ["buildSystems", "settings"]);
  assert.equal(result.version.pluginAPIVersion, 3);
  assert.equal(result.version.downloads.length, 2);
  assert.equal(result.version.downloads[0].sha256, createHash("sha256").update(fixture.release.assets[0].bytes).digest("hex"));
});

test("release tracking rejects malformed or conflicting requirements across platforms", { timeout: 5_000 }, async () => {
  const entry = capabilityEntry();
  const manifest = manifestFor(entry);
  const missing = { ...manifest };
  delete missing.requires;
  for (const [other, expected] of [
    [{ ...manifest, requires: { buildSystems: 2 } }, /disagree.*requires/],
    [{ ...manifest, requires: { buildSystems: 1, settings: 1 } }, /disagree.*requires/],
    [{ ...manifest, requires: {} }, /non-empty/],
    [missing, /must list its capabilities/],
    [{ ...manifest, version: "3.0.0" }, /disagree.*version/],
    [{ ...manifest, pluginAPIVersion: 4 }, /disagree.*pluginAPIVersion/],
  ]) {
    const fixture = releaseFixture(entry, [manifest, other]);
    const result = await versionFromRelease(entry, fixture.release, fixture);
    assert.equal(result.version, undefined);
    assert.match(result.problems.join(), expected);
  }
});

test("release tracking preserves API 1/2 releases without adding requires", { timeout: 5_000 }, async () => {
  for (const api of [1, 2]) {
    const entry = validEntry();
    entry.versions[0].pluginAPIVersion = api;
    const fixture = releaseFixture(entry, [manifestFor(entry)]);
    const result = await versionFromRelease(entry, fixture.release, fixture);
    assert.equal(result.problems, undefined);
    assert.equal(result.version.pluginAPIVersion, api);
    assert.equal(Object.hasOwn(result.version, "requires"), false);
  }
});

// Organization discovery fixtures: GitHub responses are plain objects, and each
// archive's bytes are its plugin.json text, so no test touches the network or unzip.
const REPOSITORIES_PATH = "orgs/Lithe-IDEA/repos?type=public&per_page=100&page=1";
const ZIG_ID = "io.github.lithe-idea.zig-support";

function organizationRepository(name, overrides = {}) {
  return {
    name,
    full_name: `Lithe-IDEA/${name}`,
    html_url: `https://github.com/Lithe-IDEA/${name}`,
    private: false,
    archived: false,
    fork: false,
    description: "Zig language support for Lithe",
    license: { spdx_id: "Apache-2.0" },
    topics: ["language", "zig"],
    ...overrides,
  };
}

function organizationRelease(repository, version, overrides = {}) {
  const name = `zig-support-${version}-darwin.zip`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-11-01T00:00:00Z",
    assets: [{ name, browser_download_url: `${repository.html_url}/releases/download/v${version}/${name}` }],
    ...overrides,
  };
}

function zigManifest(version) {
  return {
    schemaVersion: 2,
    id: ZIG_ID,
    displayName: "Zig Support",
    version,
    pluginAPIVersion: 2,
    vendor: { displayName: "Lithe Community", signatureRequirement: "none" },
  };
}

function organizationFixture(responses, manifestsByURL) {
  const downloads = [];
  return {
    downloads,
    request: async (path) => {
      assert.ok(Object.hasOwn(responses, path), `unexpected GitHub request: ${path}`);
      return structuredClone(responses[path]);
    },
    downloadArchive: async (url) => {
      assert.ok(Object.hasOwn(manifestsByURL, url), `unexpected download: ${url}`);
      downloads.push(url);
      return Buffer.from(JSON.stringify(manifestsByURL[url]));
    },
    readManifests: (bytes, pluginID) => {
      const manifest = JSON.parse(bytes.toString());
      return { manifests: pluginID === undefined || manifest.id === pluginID ? [manifest] : [], unsafe: [] };
    },
  };
}

function zigOrganization() {
  const repository = organizationRepository("lithe-plugin-zig");
  const releases = [
    organizationRelease(repository, "1.2.0", { prerelease: true }),
    organizationRelease(repository, "1.1.0"),
    organizationRelease(repository, "1.0.0"),
  ];
  const manifestsByURL = Object.fromEntries(releases.map((release) =>
    [release.assets[0].browser_download_url, zigManifest(release.tag_name.slice(1))]));
  const fixture = organizationFixture({
    [REPOSITORIES_PATH]: [repository, organizationRepository("lithe-plugin-docs")],
    "repos/Lithe-IDEA/lithe-plugin-zig/releases?per_page=20": releases,
  }, manifestsByURL);
  return { releases, fixture };
}

test("organization discovery considers only active, unlisted lithe-plugin- repositories", () => {
  const index = { schemaVersion: 1, plugins: [{ ...validEntry(), repository: "https://github.com/Lithe-IDEA/Lithe-Plugin-Listed" }] };
  const names = unlistedPluginRepositories([
    organizationRepository("lithe-plugin-zig"),
    organizationRepository("lithe-plugin-docs"),
    organizationRepository("lithe-plugin-listed"),
    organizationRepository("lithe-plugin-old", { archived: true }),
    organizationRepository("lithe-plugin-copy", { fork: true }),
    organizationRepository("lithe-plugin-secret", { private: true }),
    organizationRepository("Lithe-store"),
  ], index).map((repository) => repository.name);
  assert.deepEqual(names, ["lithe-plugin-zig"]);
});

test("organization discovery lists a new plugin with its stable releases", { timeout: 5_000 }, async () => {
  const { releases, fixture } = zigOrganization();
  const index = { schemaVersion: 1, plugins: [validEntry(), { ...validEntry(), id: "org.example.zig-tools" }] };
  const result = await discoverPlugins(index, fixture);

  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.newPlugins, [ZIG_ID]);
  assert.deepEqual(result.added, [`${ZIG_ID}@1.1.0 (v1.1.0) [new plugin]`, `${ZIG_ID}@1.0.0 (v1.0.0) [new plugin]`]);
  assert.deepEqual(index.plugins.map((entry) => entry.id), ["io.example.zig-support", ZIG_ID, "org.example.zig-tools"]);
  const { versions, ...metadata } = index.plugins[1];
  assert.deepEqual(metadata, {
    id: ZIG_ID,
    name: "Zig Support",
    author: "Lithe Community",
    repository: "https://github.com/Lithe-IDEA/lithe-plugin-zig",
    homepage: "https://github.com/Lithe-IDEA/lithe-plugin-zig#readme",
    description: "Zig language support for Lithe",
    tags: ["language", "zig"],
    license: "Apache-2.0",
  });
  assert.deepEqual(versions.map((version) => version.version), ["1.1.0", "1.0.0"]);
  assert.deepEqual(validateIndex(index), []);
  // The draft and its first version share one download; the pre-release is never fetched.
  assert.deepEqual(fixture.downloads, [releases[1], releases[2]].map((release) => release.assets[0].browser_download_url));
});

test("organization discovery keeps only the plugin named by --plugin", { timeout: 5_000 }, async () => {
  const other = zigOrganization();
  const otherIndex = { schemaVersion: 1, plugins: [validEntry()] };
  const skippedRun = await discoverPlugins(otherIndex, { ...other.fixture, onlyPlugin: "io.example.other" });
  assert.deepEqual(skippedRun.added, []);
  assert.equal(otherIndex.plugins.length, 1);

  const named = zigOrganization();
  const namedIndex = { schemaVersion: 1, plugins: [validEntry()] };
  const namedRun = await discoverPlugins(namedIndex, { ...named.fixture, onlyPlugin: ZIG_ID });
  assert.deepEqual(namedRun.newPlugins, [ZIG_ID]);
});

test("organization discovery skips repositories that cannot be listed yet", { timeout: 5_000 }, async () => {
  const preview = organizationRepository("lithe-plugin-preview");
  const unlicensed = organizationRepository("lithe-plugin-unlicensed", { license: { spdx_id: "NOASSERTION" } });
  const undescribed = organizationRepository("lithe-plugin-undescribed", { description: null });
  const copy = organizationRepository("lithe-plugin-copy");
  const copyRelease = organizationRelease(copy, "1.0.0");
  const anonymous = organizationRepository("lithe-plugin-anonymous");
  const anonymousRelease = organizationRelease(anonymous, "1.0.0");
  const official = organizationRepository("lithe-plugin-official");
  const officialRelease = organizationRelease(official, "1.0.0");
  const fixture = organizationFixture({
    [REPOSITORIES_PATH]: [preview, unlicensed, undescribed, copy, anonymous, official],
    "repos/Lithe-IDEA/lithe-plugin-preview/releases?per_page=20": [organizationRelease(preview, "0.1.0", { prerelease: true })],
    "repos/Lithe-IDEA/lithe-plugin-unlicensed/releases?per_page=20": [organizationRelease(unlicensed, "1.0.0")],
    "repos/Lithe-IDEA/lithe-plugin-undescribed/releases?per_page=20": [organizationRelease(undescribed, "1.0.0")],
    "repos/Lithe-IDEA/lithe-plugin-copy/releases?per_page=20": [copyRelease],
    "repos/Lithe-IDEA/lithe-plugin-anonymous/releases?per_page=20": [anonymousRelease],
    "repos/Lithe-IDEA/lithe-plugin-official/releases?per_page=20": [officialRelease],
  }, {
    [copyRelease.assets[0].browser_download_url]: { ...zigManifest("1.0.0"), id: "io.example.zig-support" },
    [anonymousRelease.assets[0].browser_download_url]: { ...zigManifest("1.0.0"), id: "io.github.lithe-idea.anonymous", vendor: { signatureRequirement: "none" } },
    [officialRelease.assets[0].browser_download_url]: { ...zigManifest("1.0.0"), id: "dev.lithe.official" },
  });
  const index = { schemaVersion: 1, plugins: [validEntry()] };
  const result = await discoverPlugins(index, fixture);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.newPlugins, []);
  assert.equal(index.plugins.length, 1);
  const log = result.skipped.join("\n");
  assert.match(log, /lithe-plugin-preview: no stable release/);
  assert.match(log, /lithe-plugin-unlicensed: GitHub detects no license/);
  assert.match(log, /lithe-plugin-undescribed: the repository has no description/);
  assert.match(log, /lithe-plugin-copy: io\.example\.zig-support is already listed for https:\/\/github\.com\/example\/lithe-zig/);
  // A drafted entry that the index would reject never gains a version, so it is not listed.
  assert.match(log, /io\.github\.lithe-idea\.anonymous.*author/);
  assert.match(log, /dev\.lithe\.official.*officialNamespace/);
  // Metadata problems are found before any archive is downloaded.
  assert.deepEqual(fixture.downloads, [copyRelease, anonymousRelease, officialRelease].map((release) => release.assets[0].browser_download_url));
});

test("plugins whose repository belongs to Lithe-IDEA are organization plugins, in any letter case", () => {
  assert.equal(isOrganizationEntry({ repository: "https://github.com/lithe-idea/lithe-plugin-zig" }), true);
  assert.equal(isOrganizationEntry({ repository: "https://github.com/Lithe-IDEA/lithe-plugin-zig/" }), true);
  assert.equal(isOrganizationEntry(validEntry()), false);
});

// A listed organization plugin and the external fixture plugin, each with one new release.
function scopedTracking() {
  const zigRepository = organizationRepository("lithe-plugin-zig");
  const organizationPluginRelease = organizationRelease(zigRepository, "1.1.0");
  const externalRelease = organizationRelease({ html_url: "https://github.com/example/lithe-zig" }, "9.0.0");
  const organizationEntry = {
    id: ZIG_ID,
    name: "Zig Support",
    author: "Lithe Community",
    repository: zigRepository.html_url,
    description: "Zig language support for Lithe",
    license: "Apache-2.0",
    versions: [],
  };
  const index = { schemaVersion: 1, plugins: [validEntry(), organizationEntry] };
  const fixture = organizationFixture({
    [REPOSITORIES_PATH]: [zigRepository],
    "repos/Lithe-IDEA/lithe-plugin-zig/releases?per_page=20": [organizationPluginRelease],
    "repos/example/lithe-zig/releases?per_page=20": [externalRelease],
  }, {
    [organizationPluginRelease.assets[0].browser_download_url]: zigManifest("1.1.0"),
    [externalRelease.assets[0].browser_download_url]: { ...zigManifest("9.0.0"), id: "io.example.zig-support" },
  });
  const requests = [];
  const request = (path) => {
    requests.push(path);
    return fixture.request(path);
  };
  return { index, archiveIO: { ...fixture, request }, requests };
}

test("scoped tracking separates organization plugins from external plugins", { timeout: 5_000 }, async () => {
  const organization = scopedTracking();
  const organizationRun = await trackIndex(organization.index, { ...organization.archiveIO, scope: "organization" });
  assert.deepEqual(organizationRun.skipped, []);
  assert.deepEqual(organizationRun.added, [`${ZIG_ID}@1.1.0 (v1.1.0)`]);
  assert.deepEqual(organization.requests, ["repos/Lithe-IDEA/lithe-plugin-zig/releases?per_page=20", REPOSITORIES_PATH]);

  const external = scopedTracking();
  const externalRun = await trackIndex(external.index, { ...external.archiveIO, scope: "external" });
  assert.deepEqual(externalRun.skipped, []);
  assert.deepEqual(externalRun.added, ["io.example.zig-support@9.0.0 (v9.0.0)"]);
  assert.deepEqual(externalRun.newPlugins, []);
  // The external pass never scans the organization, so it cannot list a plugin for the first time.
  assert.deepEqual(external.requests, ["repos/example/lithe-zig/releases?per_page=20"]);

  const unscoped = scopedTracking();
  const unscopedRun = await trackIndex(unscoped.index, unscoped.archiveIO);
  assert.deepEqual(unscopedRun.added, ["io.example.zig-support@9.0.0 (v9.0.0)", `${ZIG_ID}@1.1.0 (v1.1.0)`]);
});

test("archive verification rechecks changed manifest expectations for the same URL and hash", { timeout: 5_000 }, async () => {
  const entry = capabilityEntry();
  const manifest = manifestFor(entry);
  const bytes = Buffer.from(JSON.stringify(manifest));
  for (const download of entry.versions[0].downloads) download.sha256 = createHash("sha256").update(bytes).digest("hex");
  const index = { schemaVersion: 1, plugins: [entry] };
  let downloadCount = 0;
  const dependencies = {
    download: async () => { downloadCount += 1; return bytes; },
    readManifests: () => ({ manifests: [manifest], unsafe: [] }),
    log: () => {},
  };
  assert.deepEqual(await verifyArchives(index, structuredClone(index), dependencies), []);
  assert.equal(downloadCount, 0);
  for (const editBase of [
    (oldEntry) => { oldEntry.versions[0].requires = { buildSystems: 2 }; },
    (oldEntry) => { oldEntry.versions[0].pluginAPIVersion = 4; },
    (oldEntry) => { oldEntry.versions[0].version = "1.0.0"; },
    (oldEntry) => { oldEntry.id = "io.example.other"; },
  ]) {
    const base = structuredClone(index);
    editBase(base.plugins[0]);
    downloadCount = 0;
    assert.deepEqual(await verifyArchives(index, base, dependencies), []);
    assert.equal(downloadCount, entry.versions[0].downloads.length);
  }
  const changed = structuredClone(index);
  changed.plugins[0].versions[0].requires = { buildSystems: 2 };
  assert.match((await verifyArchives(changed, index, dependencies)).join(), /requires != index requires/);
});

test("archive verification compares requires by value and checks hashes before manifests", { timeout: 5_000 }, async () => {
  const entry = capabilityEntry();
  entry.versions[0].requires = { settings: 1, buildSystems: 1 };
  const index = { schemaVersion: 1, plugins: [entry] };
  const base = structuredClone(index);
  base.plugins[0].versions[0].requires = { buildSystems: 1, settings: 1 };
  const forbidden = () => { assert.fail("unchanged archives must not be downloaded or inspected"); };
  assert.deepEqual(await verifyArchives(index, base, { download: forbidden, readManifests: forbidden }), []);
  const problems = await verifyArchives(index, undefined, {
    download: async () => Buffer.from("wrong checksum"),
    readManifests: forbidden,
  });
  assert.equal(problems.length, entry.versions[0].downloads.length);
  assert.ok(problems.every((problem) => problem.includes("plugin.archive.checksumMismatch")));
});

test("the published index is valid", () => {
  const index = JSON.parse(readFileSync(new URL("../lithe-plugin-index.json", import.meta.url)));
  assert.deepEqual(validateIndex(index), []);
});

test("the published index is canonically formatted", () => {
  const text = readFileSync(new URL("../lithe-plugin-index.json", import.meta.url), "utf8");
  assert.equal(text, formatIndex(JSON.parse(text)));
});

test("formatting keeps plain arrays inline and round-trips", () => {
  const text = formatIndex(fixtureIndex);
  assert.deepEqual(JSON.parse(text), fixtureIndex);
  assert.match(text, /"platforms": \["darwin-arm64"\]/);
  assert.match(text, /"tags": \["Language", "zig"\]/);
  assert.equal(formatIndex({ schemaVersion: 1, plugins: [] }), '{\n  "schemaVersion": 1,\n  "plugins": []\n}\n');
});

test("duplicate ids and unsorted plugins fail the store policy", () => {
  const second = { ...validEntry(), id: "io.example.another" };
  assert.match(validateIndex({ schemaVersion: 1, plugins: [validEntry(), validEntry()] }).join("\n"), /plugin\.index\.duplicate/);
  assert.match(validateIndex({ schemaVersion: 1, plugins: [validEntry(), second] }).join("\n"), /sorted by id/);
  assert.deepEqual(validateIndex({ schemaVersion: 1, plugins: [second, validEntry()] }), []);
});

test("a wrong schema version or extra root field is refused", () => {
  assert.notDeepEqual(validateIndex({ schemaVersion: 2, plugins: [] }), []);
  assert.notDeepEqual(validateIndex({ schemaVersion: 1, plugins: [], extra: true }), []);
});

test("asset names map to platforms", () => {
  assert.deepEqual(platformsForAsset("zig-2.0.0-darwin-arm64.zip"), ["darwin-arm64"]);
  assert.deepEqual(platformsForAsset("zig-2.0.0-windows-x64.zip"), ["windows-x64"]);
  assert.deepEqual(platformsForAsset("zig-2.0.0-darwin.zip"), ["darwin-arm64", "darwin-x64"]);
  assert.equal(platformsForAsset("zig-2.0.0.tar.gz"), null);
  assert.equal(platformsForAsset("source.zip"), null);
});

test("new versions are kept newest first and replace the same version", () => {
  const entry = validEntry();
  addVersion(entry, { ...entry.versions[0], version: "10.0.0" });
  addVersion(entry, { ...entry.versions[0], version: "1.10.0" });
  assert.deepEqual(entry.versions.map((version) => version.version), ["10.0.0", "2.0.0", "1.10.0", "1.9.0"]);
});

test("archives must hold one matching community plugin.json", () => {
  const workDir = mkdtempSync(join(tmpdir(), "lithe-store-test-"));
  try {
    const entry = validEntry();
    const version = entry.versions[1];
    const build = (manifest) => {
      const packageDir = join(workDir, "pkg", entry.id);
      rmSync(join(workDir, "pkg"), { recursive: true, force: true });
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "plugin.json"), JSON.stringify(manifest));
      const archive = join(workDir, "plugin.zip");
      rmSync(archive, { force: true });
      execFileSync("zip", ["-qr", archive, entry.id], { cwd: join(workDir, "pkg") });
      return archive;
    };
    const manifest = { id: entry.id, version: version.version, pluginAPIVersion: 1, vendor: { signatureRequirement: "none" } };
    assert.deepEqual(inspectArchive(build(manifest), entry, version), []);
    assert.match(inspectArchive(build({ ...manifest, version: "9.9.9" }), entry, version).join(), /plugin\.package\.mismatch/);
    assert.match(
      inspectArchive(build({ ...manifest, vendor: { signatureRequirement: "publisherPackage" } }), entry, version).join(),
      /signatureRequirement/,
    );
    assert.match(inspectArchive(build({ ...manifest, id: "io.other" }), entry, version).join(), /exactly one plugin\.json/);
    // Without an ID (an unlisted plugin) every manifest that declares one is returned.
    assert.deepEqual(readPackageManifests(build({ ...manifest, id: "io.other" })).manifests.map((found) => found.id), ["io.other"]);
    assert.deepEqual(readPackageManifests(build({ version: "1.0.0" })).manifests, []);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});


test("the overview renders one escaped card per plugin with a default icon", () => {
  const entry = validEntry();
  delete entry.icon;
  entry.name = "<Zig>";
  const html = renderOverview({ schemaVersion: 1, plugins: [entry] });
  assert.match(html, /&lt;Zig&gt;/);
  assert.match(html, /assets\/plugin-default\.svg/);
  assert.equal(html.match(/<td /g).length, 2, "the last row is padded to two columns");
  assert.ok(html.startsWith(START) && html.endsWith(END));
});

test("overview helpers derive category, systems and truncated text", () => {
  assert.equal(categoryOf({ tags: ["go", "language"] }), "语言支持");
  assert.equal(categoryOf({ tags: ["vcs", "svn"] }), "版本控制");
  assert.equal(categoryOf({ tags: ["misc"] }), "其他");
  const version = { downloads: [{ platforms: ["windows-x64"] }, { platforms: ["darwin-arm64", "darwin-x64"] }] };
  assert.deepEqual(systemsOf(version), ["macOS", "Windows"]);
  assert.equal(truncate("abcdef", 3), "abc…");
  assert.equal(truncate("abc", 3), "abc");
});

test("rendering refuses a README without the overview markers", () => {
  assert.throws(() => renderReadme("# Lithe Store\n", { plugins: [] }), /markers/);
});
