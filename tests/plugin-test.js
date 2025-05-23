import fs from "node:fs";
import { createTempDir } from "broccoli-test-helper";
import _ from "lodash";
import { factory, runTasks } from "release-it/test/util/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import Plugin from "../index.js";
import { packageName } from "../index.js";

class TestPlugin extends Plugin {
	constructor(...args) {
		super(...args);

		this.operations = [];
		this.commands = [];
		this.prompts = [];
		this.logs = [];
	}
}

async function buildPlugin(config = {}, _Plugin = TestPlugin) {
	const container = {};
	const commandResponses = {};
	const promptResponses = {};

	const options = { [packageName]: config };
	const plugin = await factory(_Plugin, {
		container,
		namespace: packageName,
		options,
	});

	plugin.log.log = (...args) => {
		plugin.logs.push(args);

		plugin.operations.push({
			operationType: "log",
			messages: args,
		});
	};

	plugin.commandResponses = commandResponses;
	plugin.promptResponses = promptResponses;

	// when in CI mode (all tests are ran in CI mode) `Plugin.prototype.step`
	// goes through `spinner.show` (in normal mode it goes through `prompt.show`)
	plugin.spinner.show = (options) => {
		const relativeRoot = plugin.context.currentPackage
			? plugin.context.currentPackage.relativeRoot
			: ".";
		let response = promptResponses[relativeRoot]?.[options.prompt];

		if (options.prompt) {
			const prompt = plugin.prompt.prompts[plugin.namespace][options.prompt];

			// uses the same prompting logic from release-it itself:
			//
			// https://github.com/release-it/release-it/blob/13.5.0/lib/prompt.js#L19-L24
			const promptDetails = Object.assign({}, prompt, {
				operationType: "prompt",
				name: options.prompt,
				message: prompt.message(options.context),
				choices: "choices" in prompt && prompt.choices(options.context),
				transformer:
					"transformer" in prompt && prompt.transformer(options.context),
			});

			plugin.prompts.push(promptDetails);
		}

		if (Array.isArray(response)) {
			response = response.shift();
		}

		if (options.enabled !== false) {
			return options.task(response);
		}
	};

	// this works around a fairly fundamental issue in release-it's testing
	// harness which is that the ShellStub that is used specifically noop's when
	// the command being invoked is `/^(npm (ping|publish|show|whoami)|git fetch)/.test(command)`
	//
	// we work around the same relative issue by storing the commands executed,
	// and intercepting them to return replacement values (this is done in
	// execFormattedCommand just below)
	container.shell.exec = (command, options, context) => {
		if (!command || !command.length) return;
		return typeof command === "string"
			? container.shell.execFormattedCommand(
					_.template(command)(context),
					options,
				)
			: container.shell.execFormattedCommand(command, options);
	};
	container.shell.execFormattedCommand = async (command, options) => {
		const operation = {
			operationType: "command",
			command,
			options,
		};

		plugin.commands.push(operation);
		plugin.operations.push(operation);

		let response = commandResponses[command];

		if (response) {
			if (Array.isArray(response)) {
				response = response.shift();
			}

			if (typeof response === "string") {
				return Promise.resolve(response);
			}

			if (
				typeof response === "object" &&
				response !== null &&
				response.reject === true
			) {
				return Promise.reject(new Error(response.value));
			}
		}
	};

	return plugin;
}

function json(obj) {
	return JSON.stringify(obj, null, 2);
}

describe("@release-it-plugins/workspaces", () => {
	const ROOT = process.cwd();
	let dir;

	function setupProject(workspaces, pkg = {}) {
		dir.write({
			"package.json": json({
				name: "root",
				version: "0.0.0",
				license: "MIT",
				private: true,
				workspaces,
				...pkg,
			}),
		});
	}

	function setupPnpmWorkspace(packages) {
		dir.write({
			"package.json": json({
				name: "root",
				version: "0.0.0",
				license: "MIT",
				private: true,
			}),
		});

		dir.write({
			"pnpm-workspace.yaml": YAML.stringify({
				packages,
			}),
		});
	}

	function setupWorkspace(_pkg) {
		const pkg = Object.assign(
			{
				version: "0.0.0",
				license: "MIT",
			},
			_pkg,
		);

		const hasScope = pkg.name.startsWith("@");
		if (hasScope) {
			const [scope, name] = pkg.name.split("/");

			dir.write({
				packages: {
					[scope]: {
						[name]: {
							"package.json": json(pkg),
						},
					},
				},
			});
		} else {
			dir.write({
				packages: {
					[pkg.name]: {
						"package.json": json(pkg),
					},
				},
			});
		}
	}

	function readWorkspacePackage(name) {
		const contents = dir.readText(`packages/${name}/package.json`);

		return JSON.parse(contents);
	}

	beforeEach(async () => {
		dir = await createTempDir();

		process.chdir(dir.path());
	});

	afterEach(async () => {
		process.chdir(ROOT);

		await dir.dispose();
	});

	describe("normal project setup", () => {
		beforeEach(() => {
			setupProject(["packages/*"]);
			setupWorkspace({ name: "foo" });
			setupWorkspace({ name: "bar" });
		});

		it("works", async () => {
			const plugin = await buildPlugin();

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/bar --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);

			expect(JSON.parse(dir.readText("package.json")).version).toEqual("1.0.1");
			expect(readWorkspacePackage("bar").version).toEqual("1.0.1");
			expect(readWorkspacePackage("foo").version).toEqual("1.0.1");
		});

		it("updates dependencies / devDependencies of packages", async () => {
			setupWorkspace({ name: "derp" });
			setupWorkspace({ name: "qux" });

			setupWorkspace({
				name: "baz",

				dependencies: {
					foo: "^1.0.0",
				},
				devDependencies: {
					bar: "~1.0.0",
				},
				optionalDependencies: {
					qux: "1.0.0",
				},
				peerDependencies: {
					derp: "^1.0.0",
				},
			});

			const plugin = await buildPlugin();

			await runTasks(plugin);

			const pkg = JSON.parse(dir.readText("packages/baz/package.json"));

			expect(pkg).toEqual({
				name: "baz",
				license: "MIT",
				version: "1.0.1",

				dependencies: {
					foo: "^1.0.1",
				},
				devDependencies: {
					bar: "~1.0.1",
				},
				optionalDependencies: {
					qux: "1.0.1",
				},
				peerDependencies: {
					derp: "^1.0.1",
				},
			});
		});

		it("allows specifying additional locations for updating package.json versions", async () => {
			dir.write({
				dist: {
					packages: {
						zorp: {
							"package.json": json({
								name: "whatever",
								version: "1.0.0",
							}),
						},
					},
				},
			});

			const plugin = await buildPlugin({
				additionalManifests: {
					versionUpdates: ["dist/packages/*/package.json"],
				},
			});

			await runTasks(plugin);

			const pkg = JSON.parse(dir.readText("dist/packages/zorp/package.json"));

			expect(pkg).toEqual({
				name: "whatever",
				version: "1.0.1",
			});
		});

		it("allows specifying additional locations for updating dependencies / devDependencies of packages", async () => {
			dir.write({
				blueprints: {
					zorp: {
						files: {
							"package.json": json({
								name: "whatever",

								dependencies: {
									foo: "^1.0.0",
									bar: "^1.0.0",
								},
							}),
						},
					},
					derp: {
						files: {
							"package.json": json({
								name: "whatever",

								dependencies: {
									foo: "^1.0.0",
									bar: "^1.0.0",
								},
							}),
						},
					},
				},
			});

			const plugin = await buildPlugin({
				additionalManifests: {
					dependencyUpdates: ["blueprints/*/files/package.json"],
				},
			});

			await runTasks(plugin);

			for (const name of ["derp", "zorp"]) {
				const pkg = JSON.parse(
					dir.readText(`blueprints/${name}/files/package.json`),
				);

				expect(pkg).toEqual({
					name: "whatever",

					dependencies: {
						foo: "^1.0.1",
						bar: "^1.0.1",
					},
				});
			}
		});

		it("prompts to ask if the package should be public when private package publishing fails", async () => {
			setupProject(["packages/@scope-name/*"]);
			setupWorkspace({ name: "@scope-name/bar" });
			setupWorkspace({ name: "@scope-name/foo" });

			const plugin = await buildPlugin();

			plugin.commandResponses[
				"npm publish ./packages/@scope-name/bar --tag latest"
			] = [
				{
					reject: true,
					value:
						"Payment Required - PUT https://registry.npmjs.org/@scope-name/bar - You must sign up for private packages",
				},
			];

			plugin.promptResponses["packages/@scope-name/bar"] = {
				"publish-as-public": true,
			};

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/@scope-name/bar --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/@scope-name/bar --tag latest --access public",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/@scope-name/foo --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/@scope-name/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/@scope-name/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("can specify custom workspaces (overrides package.json settings)", async () => {
			function setupDistWorkspace(_pkg) {
				const pkg = Object.assign(
					{
						version: "0.0.0",
						license: "MIT",
					},
					_pkg,
				);
				const name = pkg.name;

				dir.write({
					dist: {
						packages: {
							[name]: {
								"package.json": json(pkg),
							},
						},
					},
				});
			}

			setupDistWorkspace({ name: "qux" });
			setupDistWorkspace({ name: "zorp" });

			const plugin = await buildPlugin({ workspaces: ["dist/packages/*"] });

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./dist/packages/qux --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./dist/packages/zorp --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/qux",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/zorp",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("uses specified distTag", async () => {
			const plugin = await buildPlugin({ distTag: "foo" });

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/bar --tag foo",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag foo",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("supports the workspace protocol as used in the glimmer-vm repo", async () => {
			setupProject(["packages/@glimmer/*"]);
			setupWorkspace({ name: "@glimmer/interfaces", version: "1.0.0" });
			setupWorkspace({
				name: "@glimmer/runtime",
				version: "1.0.0",
				dependencies: { "@glimmer/interfaces": "workspace:*" },
			});

			const plugin = await buildPlugin();

			await runTasks(plugin);

			// dist was updated
			expect(
				JSON.parse(dir.readText("packages/@glimmer/interfaces/package.json")),
			).toEqual({
				license: "MIT",
				name: "@glimmer/interfaces",
				version: "1.0.1",
			});
			expect(
				JSON.parse(dir.readText("packages/@glimmer/runtime/package.json")),
			).toEqual({
				license: "MIT",
				name: "@glimmer/runtime",
				version: "1.0.1",
				dependencies: { "@glimmer/interfaces": "workspace:*" },
			});
		});

		it("skips registry checks with skipChecks", async () => {
			const plugin = await buildPlugin({ skipChecks: true });

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm publish ./packages/bar --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("uses custom registry", async () => {
			setupProject(["packages/*"], {
				publishConfig: { registry: "http://my-custom-registry" },
			});
			const plugin = await buildPlugin();

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry http://my-custom-registry",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry http://my-custom-registry",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/bar --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 http://my-custom-registry/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 http://my-custom-registry/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("uses custom registry (scoped)", async () => {
			setupProject(["packages/*"], {
				publishConfig: { "@scope:registry": "http://my-custom-registry" },
			});
			const plugin = await buildPlugin();

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry http://my-custom-registry",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry http://my-custom-registry",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/bar --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 http://my-custom-registry/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 http://my-custom-registry/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("uses prerelease npm dist-tag", async () => {
			const plugin = await buildPlugin();

			plugin.getIncrementedVersion = () => "1.0.0-beta.1";

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/bar --tag beta",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag beta",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});

		it("when publishing rejects requiring a one time password", async () => {
			const plugin = await buildPlugin();

			plugin.commandResponses["packages/bar"] = {
				"npm publish . --tag latest": [
					{
						reject: true,
						value: "This operation requires a one-time password",
					},
				],
			};

			plugin.promptResponses["packages/bar"] = {
				otp: "123456",
			};

			await runTasks(plugin);

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./packages/bar --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./packages/foo --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/bar",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/foo",
            ],
            "operationType": "log",
          },
        ]
      `);
		});
	});

	describe("acceptance", () => {
		it("@glimmerjs/glimmer-vm style setup", async () => {
			setupProject(["packages/@glimmer/*"]);
			setupWorkspace({ name: "@glimmer/interfaces", version: "1.0.0" });
			setupWorkspace({
				name: "@glimmer/runtime",
				version: "1.0.0",
				dependencies: { "@glimmer/interfaces": "1.0.0" },
			});

			dir.write({
				dist: {
					"@glimmer": {
						interfaces: {
							"package.json": json({
								name: "@glimmer/interfaces",
								version: "1.0.0",
							}),
						},
						runtime: {
							"package.json": json({
								name: "@glimmer/runtime",
								version: "1.0.0",
								dependencies: { "@glimmer/interfaces": "1.0.0" },
							}),
						},
					},
				},
			});

			const plugin = await buildPlugin({
				workspaces: ["dist/@glimmer/*"],
				additionalManifests: {
					dependencyUpdates: ["packages/*/*/package.json"],
					versionUpdates: ["packages/*/*/package.json"],
				},
			});

			await runTasks(plugin);

			// dist was updated
			expect(
				JSON.parse(dir.readText("dist/@glimmer/interfaces/package.json")),
			).toEqual({
				name: "@glimmer/interfaces",
				version: "1.0.1",
			});
			expect(
				JSON.parse(dir.readText("dist/@glimmer/runtime/package.json")),
			).toEqual({
				name: "@glimmer/runtime",
				version: "1.0.1",
				dependencies: { "@glimmer/interfaces": "1.0.1" },
			});

			// packages/@glimmer/* was updated
			expect(
				JSON.parse(dir.readText("packages/@glimmer/interfaces/package.json")),
			).toEqual({
				license: "MIT",
				name: "@glimmer/interfaces",
				version: "1.0.1",
			});
			expect(
				JSON.parse(dir.readText("packages/@glimmer/runtime/package.json")),
			).toEqual({
				license: "MIT",
				name: "@glimmer/runtime",
				version: "1.0.1",
				dependencies: { "@glimmer/interfaces": "1.0.1" },
			});

			expect(plugin.operations).toMatchInlineSnapshot(`
        [
          {
            "command": "npm ping --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm whoami --registry https://registry.npmjs.org",
            "operationType": "command",
            "options": undefined,
          },
          {
            "command": "npm publish ./dist/@glimmer/interfaces --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "command": "npm publish ./dist/@glimmer/runtime --tag latest",
            "operationType": "command",
            "options": {
              "write": false,
            },
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/@glimmer/interfaces",
            ],
            "operationType": "log",
          },
          {
            "messages": [
              "🔗 https://www.npmjs.com/package/@glimmer/runtime",
            ],
            "operationType": "log",
          },
        ]
      `);
		});
	});

	describe("format publish output", () => {
		it("correctly formats publish message for all packages", async () => {
			setupProject(["packages/*"]);

			const plugin = await buildPlugin();

			expect(
				plugin._formatPublishMessage("latest", [
					"@foo/bar",
					"@foo/baz",
					"@foo/blarg",
				]),
			).toMatchInlineSnapshot(`
        "Preparing to publish:
            @foo/bar
            @foo/baz
            @foo/blarg
          Publish to npm:"
      `);
		});
	});

	describe("getWorkspaces", () => {
		function workspaceInfoFor(name) {
			const pkg = readWorkspacePackage(name);

			return {
				name,
				isReleased: false,
				isPrivate: !!pkg.private,
				root: fs.realpathSync(dir.path(`packages/${name}`)),
				relativeRoot: `packages/${name}`,
				pkgInfo: {
					indent: 2,
					lineEndings: "\n",
					trailingWhitespace: "",
					filename: fs.realpathSync(dir.path(`packages/${name}/package.json`)),
					pkg,
				},
			};
		}

		it("returns stable values", async () => {
			setupProject(["packages/*"]);

			setupWorkspace({ name: "bar" });
			setupWorkspace({ name: "foo", private: true });

			const plugin = await buildPlugin();

			const workspaces1 = await plugin.getWorkspaces();
			const workspaces2 = await plugin.getWorkspaces();

			expect(workspaces1).toStrictEqual(workspaces2);
		});

		it("returns stable values for PNPM", async () => {
			setupPnpmWorkspace(["packages/*"]);

			setupWorkspace({ name: "bar" });
			setupWorkspace({ name: "foo", private: true });

			const plugin = await buildPlugin();

			const workspaces1 = await plugin.getWorkspaces();
			const workspaces2 = await plugin.getWorkspaces();

			expect(workspaces1).toStrictEqual(workspaces2);
		});

		it("detects private packages", async () => {
			setupProject(["packages/*"]);

			setupWorkspace({ name: "bar" });
			setupWorkspace({ name: "foo", private: true });

			const plugin = await buildPlugin();

			const workspaces = await plugin.getWorkspaces();

			expect(workspaces).toEqual([
				workspaceInfoFor("bar"),
				workspaceInfoFor("foo"),
			]);
		});

		it("can find workspaces specified as an array", async () => {
			setupProject(["packages/*"]);

			setupWorkspace({ name: "foo" });
			setupWorkspace({ name: "bar" });

			const plugin = await buildPlugin();

			const workspaces = await plugin.getWorkspaces();

			expect(workspaces).toEqual([
				workspaceInfoFor("bar"),
				workspaceInfoFor("foo"),
			]);
		});

		it("can find workspaces specified as an object", async () => {
			setupProject({ packages: ["packages/*"] });

			setupWorkspace({ name: "foo" });
			setupWorkspace({ name: "bar" });

			const plugin = await buildPlugin();

			const workspaces = await plugin.getWorkspaces();

			expect(workspaces).toEqual([
				workspaceInfoFor("bar"),
				workspaceInfoFor("foo"),
			]);
		});

		describe("JSONFile", () => {
			it("preserves custom indentation levels when mutating", async () => {
				setupProject({ packages: ["packages/*"] });

				dir.write({
					packages: {
						foo: {
							"package.json": JSON.stringify(
								{
									name: "foo",
									version: "1.0.0",
								},
								null,
								5,
							),
						},
					},
				});

				const plugin = await buildPlugin();

				const [fooWorkspaceInfo] = await plugin.getWorkspaces();

				fooWorkspaceInfo.pkgInfo.pkg.thing = true;
				fooWorkspaceInfo.pkgInfo.write();

				expect(
					dir.readText("packages/foo/package.json"),
				).toMatchInlineSnapshot(`
          "{
               \\"name\\": \\"foo\\",
               \\"version\\": \\"1.0.0\\",
               \\"thing\\": true
          }"
        `);
			});

			it("preserves custom whitespace at end of file when mutating", async () => {
				setupProject({ packages: ["packages/*"] });

				dir.write({
					packages: {
						foo: {
							"package.json": `${JSON.stringify(
								{
									name: "foo",
									version: "1.0.0",
								},
								null,
								2,
							)}\n`,
						},
					},
				});

				const plugin = await buildPlugin();

				const [fooWorkspaceInfo] = await plugin.getWorkspaces();

				fooWorkspaceInfo.pkgInfo.pkg.thing = true;
				fooWorkspaceInfo.pkgInfo.write();

				expect(
					dir.readText("packages/foo/package.json"),
				).toMatchInlineSnapshot(`
          "{
            \\"name\\": \\"foo\\",
            \\"version\\": \\"1.0.0\\",
            \\"thing\\": true
          }
          "
        `);
			});
		});
	});

	describe("_buildReplacementDepencencyVersion", () => {
		async function updatesTo({ existing, new: newVersion, expected }) {
			it(`updates ${existing} to ${newVersion}`, async () => {
				setupProject(["packages/*"]);

				const plugin = await buildPlugin();

				expect(
					plugin._buildReplacementDepencencyVersion(existing, newVersion),
				).toEqual(expected);
			});
		}

		updatesTo({ existing: "^1.0.0", new: "2.0.0", expected: "^2.0.0" });
		updatesTo({ existing: "~1.0.0", new: "2.0.0", expected: "~2.0.0" });
		updatesTo({ existing: "1.0.0", new: "2.0.0", expected: "2.0.0" });
		updatesTo({
			existing: "^1.0.0",
			new: "2.0.0-beta.1",
			expected: "^2.0.0-beta.1",
		});
		updatesTo({
			existing: "^1.0.0-beta.1",
			new: "1.0.0-beta.2",
			expected: "^1.0.0-beta.2",
		});
		updatesTo({ existing: "^1.0.0-beta.1", new: "1.0.0", expected: "^1.0.0" });

		updatesTo({
			existing: "workspace:^1.0.0",
			new: "2.0.0",
			expected: "workspace:^2.0.0",
		});
		updatesTo({
			existing: "workspace:~1.0.0",
			new: "2.0.0",
			expected: "workspace:~2.0.0",
		});
		updatesTo({
			existing: "workspace:1.0.0",
			new: "2.0.0",
			expected: "workspace:2.0.0",
		});
		updatesTo({
			existing: "workspace:^",
			new: "2.0.0",
			expected: "workspace:^",
		});
		updatesTo({
			existing: "workspace:~",
			new: "2.0.0",
			expected: "workspace:~",
		});
		updatesTo({
			existing: "workspace:*",
			new: "2.0.0",
			expected: "workspace:*",
		});
	});
});
