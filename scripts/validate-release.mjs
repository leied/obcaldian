import { existsSync, readFileSync, readdirSync } from "node:fs";

function fail(message) {
	console.error(`Release validation failed: ${message}`);
	process.exitCode = 1;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${path} is not valid JSON: ${error.message}`);
		return {};
	}
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const requiredManifestFields = [
	"id",
	"name",
	"version",
	"minAppVersion",
	"description",
	"author",
	"isDesktopOnly",
];

for (const field of requiredManifestFields) {
	if (manifest[field] === undefined || manifest[field] === "") {
		fail(`manifest.json is missing required field "${field}".`);
	}
}

if (!/^[a-z0-9-]+$/.test(manifest.id ?? "")) {
	fail("manifest id must contain only lowercase letters, numbers, and hyphens.");
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
	fail("manifest version must use x.y.z semantic-version format.");
}
if (packageJson.version !== manifest.version) {
	fail(`package.json version ${packageJson.version} does not match manifest ${manifest.version}.`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
	fail(
		`versions.json must map ${manifest.version} to minimum app version ${manifest.minAppVersion}.`
	);
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== manifest.version) {
	fail(`release tag ${process.env.RELEASE_TAG} must exactly match ${manifest.version}.`);
}

for (const path of [
	"README.md",
	"SECURITY.md",
	"PRIVACY.md",
	"LICENSE",
	"main.js",
	"manifest.json",
	"styles.css",
]) {
	if (!existsSync(path)) fail(`required publication file ${path} is missing.`);
}

const sourceFiles = readdirSync("src", { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
	.map((entry) => `src/${entry.name}`);
for (const path of sourceFiles.filter((path) => path !== "src/network.ts")) {
	const source = readFileSync(path, "utf8");
	if (/\brequestUrl\s*\(/.test(source)) {
		fail(`${path} bypasses the centralized outbound-host allowlist.`);
	}
}

const googleAuthSource = readFileSync("src/googleAuth.ts", "utf8");
if (/import\s*\(\s*["']node:http["']\s*\)/.test(googleAuthSource)) {
	fail("googleAuth.ts must statically import node:http so Obsidian does not treat it as a web module.");
}

const allowedSourceHosts = new Set([
	"accounts.google.com",
	"oauth2.googleapis.com",
	"www.googleapis.com",
	"127.0.0.1",
]);
for (const path of sourceFiles) {
	const source = readFileSync(path, "utf8");
	for (const match of source.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
		if (!allowedSourceHosts.has(match[1])) {
			fail(`${path} contains an outbound host that is not approved: ${match[1]}.`);
		}
	}
}

if (!process.exitCode) {
	console.log(`Release files are valid for DailyCalSync ${manifest.version}.`);
}
