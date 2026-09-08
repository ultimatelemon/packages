# packages

Shared npm packages for UltimateLemon projects. One repository, published
independently to the public npm registry under `@ultimatelemon-eu`.

| Package                                                           | For                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| [`@ultimatelemon-eu/prettier-config`](./packages/prettier-config) | One formatting standard across every repository      |
| [`@ultimatelemon-eu/eslint-config`](./packages/eslint-config)     | Next.js + TypeScript linting, type-aware             |
| [`@ultimatelemon-eu/drizzle-migrate`](./packages/drizzle-migrate) | Drizzle migrations at container start, behind a lock |

## Why one repository

The organisation already carries more repositories than anyone reads, and two
of them turned out to be dead. A package does not need its own README, CI
setup and dependency bot; it needs a directory.

## Releasing

Bump the `version` in a package's `package.json` and merge to `main`. The
publish workflow compares each package against npm and publishes only what is
not there yet. There is no changeset tooling and no release branch.

Publishing runs on npm trusted publishing: GitHub Actions authenticates over
OIDC with a short-lived token, so there is no `NPM_TOKEN` to store or rotate,
and provenance is attached automatically.

### First publish of a new package

A trusted publisher can only be attached to a package that exists, so the
first version goes out by hand:

```bash
npm login
npm publish --workspace @ultimatelemon-eu/<name> --access public
```

Then on npmjs.com, under the package's settings, add a trusted publisher:

| Field      | Value           |
| ---------- | --------------- |
| Provider   | GitHub Actions  |
| Owner      | `ultimatelemon` |
| Repository | `packages`      |
| Workflow   | `publish.yml`   |

From then on CI publishes it without any credential. A trusted publisher
cannot be edited afterwards, only deleted and recreated, so the workflow
filename has to match exactly.

## Getting started

```bash
npm install
npm run build
npm run format:check
npm run typecheck
```
