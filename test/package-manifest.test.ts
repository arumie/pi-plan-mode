/**
 * Release-manifest checks for the published pi package.
 *
 * Run with: node --experimental-strip-types test/package-manifest.test.ts
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
	files?: string[];
	pi?: { extensions?: string[] };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	engines?: { node?: string };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageManifest;
const files = new Set(manifest.files ?? []);
const extensionEntry = "extensions/plan-mode/index.ts";
const runtimeModules = [extensionEntry, "extensions/plan-mode/utils.ts"];

assert.deepEqual(manifest.pi?.extensions, [`./${extensionEntry}`], "pi must load the explicit packaged extension entry");
assert.equal(manifest.engines?.node, ">=22", "package must declare its Node 22 runtime requirement");

for (const module of runtimeModules) {
	assert.ok(files.has(module), `${module} must be included in the published package`);
}

assert.ok(files.has("extensions/plan-mode/README.md"), "extension documentation must be published");
assert.ok(!files.has("extensions/plan-mode/utils.test.ts"), "test-only source must not be published");

const entrySource = await readFile(join(root, extensionEntry), "utf8");
for (const specifier of entrySource.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
	const imported = specifier[1];
	if (!imported) continue;
	const sourcePath = resolve(dirname(join(root, extensionEntry)), imported);
	const packagePath = relative(root, sourcePath);
	assert.ok(files.has(packagePath), `${packagePath} is imported by ${extensionEntry} and must be published`);
}

for (const packageName of [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]) {
	assert.equal(manifest.dependencies?.[packageName], undefined, `${packageName} must not be bundled as a runtime dependency`);
	assert.equal(manifest.peerDependencies?.[packageName], "*", `${packageName} must remain a pi host peer dependency`);
}

console.log("✓ package manifest ships the explicit pi extension and all runtime modules");
