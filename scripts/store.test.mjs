import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addVersion, platformsForAsset } from "./track-releases.mjs";
import { formatIndex, inspectArchive, validateEntry, validateIndex } from "./validate-index.mjs";

// Fixtures are copied from Lithe-IDEA shared/contracts/plugins/v1/fixtures/marketplace
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
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
