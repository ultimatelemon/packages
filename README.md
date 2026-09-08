# packages

Shared npm packages for UltimateLemon projects. One repository, published
independently to the public npm registry under `@ultimatelemon`.

| Package                                                        | For                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| [`@ultimatelemon/prettier-config`](./packages/prettier-config) | One formatting standard across every repository      |
| [`@ultimatelemon/eslint-config`](./packages/eslint-config)     | Next.js + TypeScript linting, type-aware             |
| [`@ultimatelemon/drizzle-migrate`](./packages/drizzle-migrate) | Drizzle migrations at container start, behind a lock |

## Why one repository

The organisation already carries more repositories than anyone reads, and two
of them turned out to be dead. A package does not need its own README, CI
setup and dependency bot; it needs a directory.

## Releasing

Bump the `version` in a package's `package.json` and merge to `main`. The
publish workflow compares each package against npm and publishes only what is
not there yet, with provenance. There is no changeset tooling and no release
branch.

`NPM_TOKEN` is the only secret, an automation token for the `@ultimatelemon`
scope.

## Getting started

```bash
npm install
npm run build
npm run format:check
npm run typecheck
```
