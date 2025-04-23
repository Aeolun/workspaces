import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import detectIndent from "detect-indent";
import detectNewline from "detect-newline";
import { Plugin } from "release-it";
import semver from "semver";
import urlJoin from "url-join";
import validatePeerDependencies from "validate-peer-dependencies";
import walkSync from "walk-sync";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
validatePeerDependencies(__dirname);

const options = { write: false };

const ROOT_MANIFEST_PATH = "./package.json";
const PNPM_WORKSPACE_PATH = "./pnpm-workspace.yaml";
const REGISTRY_TIMEOUT = 10000;
const DEFAULT_TAG = "latest";
const NPM_BASE_URL = "https://www.npmjs.com";
const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DETECT_TRAILING_WHITESPACE = /\s+$/;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rejectAfter(ms, error) {
	await sleep(ms);

	throw error;
}

function discoverWorkspaces() {
	const { publishConfig, workspaces } = JSON.parse(
		fs.readFileSync(path.resolve(ROOT_MANIFEST_PATH)),
	);

	if (!workspaces && hasPnpm()) {
		try {
			const workspaceContent = fs.readFileSync(
				path.resolve(PNPM_WORKSPACE_PATH),
				{
					encoding: "utf-8",
				},
			);
			const { packages: workspaces } = YAML.parse(workspaceContent);
			return { publishConfig, workspaces };
		} catch (error) {
			return { publishConfig, workspaces: [] };
		}
	}
	return { publishConfig, workspaces: workspaces || [] };
}

function hasPnpm() {
	return (
		fs.existsSync("./pnpm-lock.yaml") || fs.existsSync(PNPM_WORKSPACE_PATH)
	);
}

function resolveWorkspaces(workspaces) {
	if (Array.isArray(workspaces)) {
		return workspaces;
	}
	if (workspaces !== null && typeof workspaces === "object") {
		return workspaces.packages;
	}

	throw new Error(
		"This package doesn't use workspaces. (package.json doesn't contain a `workspaces` property)",
	);
}

function parseVersion(raw) {
	if (!raw) return { version: null, isPreRelease: false, preReleaseId: null };

	const version = semver.valid(raw) ? raw : semver.coerce(raw);
	const parsed = semver.parse(version);

	const isPreRelease = parsed.prerelease.length > 0;
	const preReleaseId =
		isPreRelease && Number.isNaN(Number(parsed.prerelease[0]))
			? parsed.prerelease[0]
			: null;

	return {
		version,
		isPreRelease,
		preReleaseId,
	};
}

function findAdditionalManifests(root, manifestPaths) {
	if (!Array.isArray(manifestPaths)) {
		return null;
	}

	const packageJSONFiles = walkSync(".", {
		globs: manifestPaths,
	});

	const manifests = packageJSONFiles.map((file) => {
		const absolutePath = path.join(root, file);
		const pkgInfo = JSONFile.for(absolutePath);

		const relativeRoot = path.dirname(file);

		return {
			root: path.join(root, relativeRoot),
			relativeRoot,
			pkgInfo,
		};
	});

	return manifests;
}

const jsonFiles = new Map();

class JSONFile {
	static for(path) {
		if (jsonFiles.has(path)) {
			return jsonFiles.get(path);
		}

		const jsonFile = new JSONFile(path);
		jsonFiles.set(path, jsonFile);

		return jsonFile;
	}

	constructor(filename) {
		const contents = fs.readFileSync(filename, { encoding: "utf8" });

		this.filename = filename;
		this.pkg = JSON.parse(contents);
		this.lineEndings = detectNewline(contents);
		this.indent = detectIndent(contents).amount;

		const trailingWhitespace = DETECT_TRAILING_WHITESPACE.exec(contents);
		this.trailingWhitespace = trailingWhitespace ? trailingWhitespace : "";
	}

	write() {
		const contents = JSON.stringify(this.pkg, null, this.indent).replace(
			/\n/g,
			this.lineEndings,
		);

		fs.writeFileSync(this.filename, contents + this.trailingWhitespace, {
			encoding: "utf8",
		});
	}
}

export const packageName = "@aeolun/workspaces";

export default class WorkspacesPlugin extends Plugin {
	static isEnabled(options) {
		return fs.existsSync(ROOT_MANIFEST_PATH) && options !== false;
	}

	constructor(...args) {
		super(...args);

		this.registerPrompts({
			publish: {
				type: "confirm",
				message: (context) => {
					const distTag = context[packageName].distTag;
					const packagesToPublish = context[packageName].packagesToPublish;

					return this._formatPublishMessage(distTag, packagesToPublish);
				},
				default: true,
			},
			otp: {
				type: "input",
				message: () => "Please enter OTP for npm:",
			},
			"publish-as-public": {
				type: "confirm",
				message(context) {
					const { currentPackage } = context[packageName];

					return `Publishing ${currentPackage.name} failed because \`publishConfig.access\` is not set in its \`package.json\`.\n  Would you like to publish ${currentPackage.name} as a public package?`;
				},
			},
		});

		const { publishConfig, workspaces } = discoverWorkspaces();

		this.setContext({
			publishConfig,
			workspaces: this.options.workspaces || resolveWorkspaces(workspaces),
			root: process.cwd(),
		});
	}

	async init() {
		if (this.options.skipChecks) return;

		const validations = Promise.all([
			this.isRegistryUp(),
			this.isAuthenticated(),
		]);

		await Promise.race([
			validations,
			rejectAfter(
				REGISTRY_TIMEOUT,
				new Error(`Timed out after ${REGISTRY_TIMEOUT}ms.`),
			),
		]);

		const [isRegistryUp, isAuthenticated] = await validations;

		if (!isRegistryUp) {
			throw new Error(
				`Unable to reach npm registry (timed out after ${REGISTRY_TIMEOUT}ms).`,
			);
		}

		if (!isAuthenticated) {
			throw new Error(
				"Not authenticated with npm. Please `npm login` and try again.",
			);
		}
	}

	beforeBump() {
		// TODO: implement printing of workspaces found
	}

	async bump(version) {
		let { distTag } = this.options;

		if (!distTag) {
			const { isPreRelease, preReleaseId } = parseVersion(version);
			distTag =
				this.options.distTag || (isPreRelease ? preReleaseId : DEFAULT_TAG);
		}
		const workspaces = this.getWorkspaces();

		const packagesToPublish = workspaces
			.filter((w) => !w.isPrivate)
			.map((workspace) => workspace.name);

		this.setContext({
			distTag,
			packagesToPublish,
			version,
		});

		const task = async () => {
			const { isDryRun } = this.config;

			const updateVersion = (pkgInfo) => {
				const { pkg } = pkgInfo;
				const originalVersion = pkg.version;

				if (originalVersion === version) {
					this.log.warn(`\tDid not update version (already at ${version}).`);
				}

				this.log.exec(`\tversion: -> ${version} (from ${originalVersion})`);

				if (!isDryRun) {
					pkg.version = version;
				}
			};

			for (const { relativeRoot, pkgInfo } of workspaces) {
				this.log.exec(`Processing ${relativeRoot}/package.json:`);

				updateVersion(pkgInfo);
				this._updateDependencies(pkgInfo, version);

				if (!isDryRun) {
					pkgInfo.write();
				}
			}

			const additionalManifests = this.getAdditionalManifests();
			if (additionalManifests.dependencyUpdates) {
				for (const {
					relativeRoot,
					pkgInfo,
				} of additionalManifests.dependencyUpdates) {
					this.log.exec(
						`Processing additionManifest.dependencyUpdates for ${relativeRoot}/package.json:`,
					);

					this._updateDependencies(pkgInfo, version);

					if (!isDryRun) {
						pkgInfo.write();
					}
				}
			}

			if (additionalManifests.versionUpdates) {
				for (const {
					relativeRoot,
					pkgInfo,
				} of additionalManifests.versionUpdates) {
					this.log.exec(
						`Processing additionManifest.versionUpdates for ${relativeRoot}/package.json:`,
					);
					updateVersion(pkgInfo);

					if (!isDryRun) {
						pkgInfo.write();
					}
				}
			}
		};

		/**
		 * In workflows where publishing is handled on C.I.,
		 * and not be release-it, the environment will often require
		 * that the lockfile be updated -- this is usually done by
		 * running the install command for the package manager.
		 */
		if (hasPnpm()) {
			await this.exec("pnpm install");
		}

		return this.spinner.show({ task, label: "npm version" });
	}

	async release() {
		if (this.options.publish === false) return;

		// creating a stable object that is shared across all package publishes
		// this ensures that we don't accidentally prompt multiple times (e.g. once
		// per package) due to loosing the otp value after each `this.publish` call
		const otp = {
			value: this.options.otp,
		};

		const tag = this.getContext("distTag");
		const task = async () => {
			await this.eachWorkspace(async (workspaceInfo) => {
				await this.publish({ tag, workspaceInfo, otp });
			});
		};

		await this.step({ task, label: "(p)npm publish", prompt: "publish" });
	}

	async afterRelease() {
		const workspaces = this.getWorkspaces();

		for (const workspaceInfo of workspaces) {
			if (workspaceInfo.isReleased) {
				this.log.log(`🔗 ${this.getReleaseUrl(workspaceInfo)}`);
			}
		}
	}

	_buildReplacementDepencencyVersion(existingVersion, newVersion) {
		let prefix = "";
		let firstChar = "";
		let range = existingVersion;
		let suffix = newVersion;

		// preserve workspace protocol prefix,
		// tools that use this replace with a real version during the publish the process
		if (existingVersion.startsWith("workspace:")) {
			prefix = "workspace:";
			range = existingVersion.slice(prefix.length);
			suffix = range.length > 1 ? newVersion : "";
		}

		// preserve existing floating constraint
		if (["^", "~"].includes(range[0])) {
			firstChar = range[0];
		}

		if ("*" === range) {
			return `${prefix}*`;
		}

		return `${prefix}${firstChar}${suffix}`;
	}

	_updateDependencies(pkgInfo, newVersion) {
		const { isDryRun } = this.config;
		const workspaces = this.getWorkspaces();
		const { pkg } = pkgInfo;

		const updateDependencies = (dependencyType) => {
			const dependencies = pkg[dependencyType];

			if (dependencies) {
				for (const dependency in dependencies) {
					if (workspaces.find((w) => w.name === dependency)) {
						const existingVersion = dependencies[dependency];
						const replacementVersion = this._buildReplacementDepencencyVersion(
							existingVersion,
							newVersion,
						);

						this.log.exec(
							`\t${dependencyType}: \`${dependency}\` -> ${replacementVersion} (from ${existingVersion})`,
						);

						if (!isDryRun) {
							dependencies[dependency] = replacementVersion;
						}
					}
				}
			}
		};

		updateDependencies("dependencies");
		updateDependencies("devDependencies");
		updateDependencies("optionalDependencies");
		updateDependencies("peerDependencies");
	}

	_formatPublishMessage(distTag, packageNames) {
		const messages = [
			"Preparing to publish:",
			...packageNames.map(
				(name) => `    ${name}${distTag === "latest" ? "" : `@${distTag}`}`,
			),
			"  Publish to npm:",
		];

		return messages.join("\n");
	}

	async isRegistryUp() {
		const registry = this.getRegistry();

		try {
			await this.exec(`npm ping --registry ${registry}`);

			return true;
		} catch (error) {
			if (
				/code E40[04]|404.*(ping not found|No content for path)/.test(error)
			) {
				this.log.warn("Ignoring unsupported `npm ping` command response.");
				return true;
			}
			return false;
		}
	}

	async isAuthenticated() {
		const registry = this.getRegistry();

		try {
			await this.exec(`npm whoami --registry ${registry}`);
			return true;
		} catch (error) {
			this.debug(error);

			if (/code E40[04]/.test(error)) {
				this.log.warn("Ignoring unsupported `npm whoami` command response.");
				return true;
			}

			return false;
		}
	}

	getReleaseUrl(workspaceInfo) {
		const registry = this.getRegistry();
		const baseUrl = registry !== NPM_DEFAULT_REGISTRY ? registry : NPM_BASE_URL;

		return urlJoin(baseUrl, "package", workspaceInfo.name);
	}

	getRegistry() {
		const { publishConfig } = this.getContext();
		const registries = publishConfig
			? publishConfig.registry
				? [publishConfig.registry]
				: Object.keys(publishConfig)
						.filter((key) => key.endsWith("registry"))
						.map((key) => publishConfig[key])
			: [];
		return registries[0] || NPM_DEFAULT_REGISTRY;
	}

	async publish({ tag, workspaceInfo, otp, access } = {}) {
		const isScoped = workspaceInfo.name.startsWith("@");
		const otpArg = otp.value ? ` --otp ${otp.value}` : "";
		const accessArg = access ? ` --access ${access}` : "";
		const dryRunArg = this.config.isDryRun ? " --dry-run" : "";
		const publishExecutable = hasPnpm() ? "pnpm" : "npm";
		const noGitChecks = hasPnpm() ? " --no-git-checks" : "";

		if (workspaceInfo.isPrivate) {
			this.debug(`${workspaceInfo.name}: Skip publish (package is private)`);
			return;
		}

		try {
			await this.exec(
				`${publishExecutable} publish ./${workspaceInfo.relativeRoot} --tag ${tag}${noGitChecks}${accessArg}${otpArg}${dryRunArg}`,
				{
					options,
				},
			);

			workspaceInfo.isReleased = true;
		} catch (err) {
			this.debug(err);
			if (/one-time pass/.test(err)) {
				if (otp.value != null) {
					this.log.warn("The provided OTP is incorrect or has expired.");
				}

				await this.step({
					prompt: "otp",
					task(newOtp) {
						otp.value = newOtp;
					},
				});

				return await this.publish({ tag, workspaceInfo, otp, access });
			}
			if (isScoped && /private packages/.test(err)) {
				let publishAsPublic = false;

				await this.step({
					prompt: "publish-as-public",
					task(value) {
						publishAsPublic = value;
					},
				});

				if (publishAsPublic) {
					return await this.publish({
						tag,
						workspaceInfo,
						otp,
						access: "public",
					});
				}
				this.log.warn(`${workspaceInfo.name} was not published.`);
			}
			throw err;
		}
	}

	async eachWorkspace(action) {
		const workspaces = this.getWorkspaces();

		for (const workspaceInfo of workspaces) {
			try {
				this.setContext({
					currentPackage: workspaceInfo,
				});

				await action(workspaceInfo);
			} finally {
				this.setContext({
					currentPackage: null,
				});
			}
		}
	}

	getAdditionalManifests() {
		const root = this.getContext("root");
		const additionalManifestsConfig = this.getContext("additionalManifests");
		const additionalManifests = {
			dependencyUpdates: null,
			versionUpdates: null,
		};

		let versionUpdates = ["package.json"];

		if (additionalManifestsConfig) {
			additionalManifests.dependencyUpdates = findAdditionalManifests(
				root,
				additionalManifestsConfig.dependencyUpdates,
			);

			if (additionalManifestsConfig.versionUpdates) {
				versionUpdates = additionalManifestsConfig.versionUpdates;
			}
		}

		additionalManifests.versionUpdates = findAdditionalManifests(
			root,
			versionUpdates,
		);

		this._additionalManifests = additionalManifests;

		return this._additionalManifests;
	}

	getWorkspaces() {
		if (this._workspaces) {
			return this._workspaces;
		}

		const root = this.getContext("root");
		const workspaces = this.getContext("workspaces");

		const packageJSONFiles = walkSync(".", {
			globs: workspaces.map((glob) => `${glob}/package.json`),
		});

		this._workspaces = packageJSONFiles.map((file) => {
			const absolutePath = path.join(root, file);
			const pkgInfo = JSONFile.for(absolutePath);

			const relativeRoot = path.dirname(file);

			return {
				root: path.join(root, relativeRoot),
				relativeRoot,
				name: pkgInfo.pkg.name,
				isPrivate: !!pkgInfo.pkg.private,
				isReleased: false,
				pkgInfo,
			};
		});

		return this._workspaces;
	}
}
