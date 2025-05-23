# @aeolun/workspaces

This package is a [release-it](https://github.com/release-it/release-it) plugin
(using [`release-it`'s plugin
API](https://github.com/release-it/release-it/blob/master/docs/plugins.md)) that
releases each of your projects configured workspaces (either npm, or pnpm. Yarn 
might be supported, but hasn't been tested).

I've updated the package to function with release it version 17/18/19, because the 
existing one seems to be unmaintained

## How it works

In order to publish each of your projects workspaces, we first check the root
`package.json` to determine the locations of each of your workspaces (handling
both globbing and various formats for `workspaces`). Once we have identified
all of the workspaces, we bump the `package.json`s `version` field to the
selected version and publish the package (by changing into the package's root
folder and calling `npm publish`).

## Usage

Installation using your projects normal package manager, for example:

```sh
npm install --save-dev @aeolun/workspaces

# or

yarn add --dev --ignore-workspace-root-check @aeolun/workspaces
```

Once installed, configure `release-it` to use the plugin.

For example, configuring via `package.json` would look like this:

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": true
    }
  }
}
```

Often times the root `package.json` for a workspace setup is commonly not
published, in order to configure `release-it` to avoid attempting to publish
the top level package (in addition to publishing your workspace packages), you
would add the following to your `release-it` config (again showing
`package.json` style configuration):

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": true
    },
    "npm": false
  }
}
```

## Configuration

For the most part `@aeolun/workspaces` "does the right thing", but
there are a few things that are configurable.

A quick summary (in TypeScript syntax) of the supported options (more details
on each just below):

```ts
interface ReleaseItWorkSpacesConfiguration {
  /**
    Disables checks for `npm` registry and login info.

    Defaults to `false`.
  */
  skipChecks?: boolean;

  /**
    Should the packges be published (`npm publish`)?

    Defaults to `true`.
  */
  publish?: boolean;

  /**
    Specifies which `dist-tag` to use when publishing.

    Defaults to `latest` for non-prerelease and the prelease type for
    prereleases (e.g. `1.0.0-beta.1` would be `beta`, and `1.0.0-alpha.1` would
    be alpha).
  */
  distTag?: string;

  /**
    The array of workspaces in the project.

    Defaults to the `package.json`'s `workspaces` value.
  */
  workspaces?: string[];

  additionalManifests?: {

    /**
      An array of `package.json` files that should have their `version`
      property updated to the newly released version.

      Defaults to `['package.json']`.
    */
    versionUpdates?: string[];

    /**
      An array of `package.json` files that should have their `dependencies`,
      `devDependencies`, `optionalDependencies`, and `peerDependencies` values
      updated to the newly published version.
    */
    dependencyUpdates?: string[];
  }
}
```

### skipChecks

By default, `@aeolun/workspaces` confirms that the `npm` registry is up
and running (via `npm ping`) and that you are authenticated properly (via `npm
whoami`). If you'd prefer to avoid these checks (e.g. your custom `npm`
registry does not support them) you can specify the `skipChecks` option:

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": {
        "skipChecks": true
      }
    }
  }
}
```

### publish

`@aeolun/workspaces` publishes to the `npm` registry.
However, some repository configurations prefer to commit + tag then let CI
publish the actual packages to the registry. This is where the `publish` option
comes in:

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": {
        "publish": false
      }
    }
  }
}
```

With this configuration, the `package.json` files in your workspaces would be
updated with the new version information but the packages would not be
published.

### distTag

`@aeolun/workspaces` uses the `latest` dist-tag when the
released version is a stable release and the prereleaseId when it is a
prerelease (e.g. `beta` for `1.0.0-beta.1`). This is a good default setup, but
there may be cases where you would like to specify a custom dist-tag to be
used.

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": {
        "distTag": "lts"
      }
    }
  }
}
```

### workspaces

The list of workspaces is gathered from the `package.json` in the current
working directory. This is the same location that `npm install`/`yarn install` uses, and it
is a great default for `@aeolun/workspaces`. In some circumstances, the
workspace settings that `npm`/`yarn` should use differ from the actual locations that
are published.  Most commonly this is due to a custom build script that emits
the compiled and ready to publish packages into a different location (e.g.
`dist/packages/*`).

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": {
        "workspaces": ["dist/packages/*"]
      }
    }
  }
}
```

This value replaces the value from `package.json`, and given the above
configuration `@aeolun/workspaces` would publish each package (that was
not private) in `dist/packages` folder.

### additionalManifests

#### versionUpdates

There are cases where you'd like to ensure JSON files other than your workspace
packages `package.json`s have their `version` property updated. For example,
you may publish an alternate `docs.json` file in your published package.

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": {
        "additionalManifests": {
          "versionUpdates": ["dist/docs.json"]
      }
    }
  }
}
```

The default configuration is `['package.json']` to ensure that the top level
`package.json`s version is updated upon release.

#### dependencyUpdates

There are cases where you'd like to ensure files other than your workspace
packages have their `dependencies` / `devDependencies` / `optionalDependencies`
/ `peerDependencies` updated but not _also_ get a `version` bump. A great
example is if you maintain a template `package.json` for consumers of your
package(s). In that case, you would not want to bump its `version` property but
you would want to ensure that any dependencies have been updated to match the
newly published versions.

```json
{
  "release-it": {
    "plugins": {
      "@aeolun/workspaces": {
        "additionalManifests": {
          "dependencyUpdates": ["blueprints/*/package.json"]
      }
    }
  }
}
```

## License

This project is licensed under the [MIT License](LICENSE.md).
