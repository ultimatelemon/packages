# CLAUDE.md

Source of the public `@ultimatelemon-eu/*` npm packages: one npm workspace per
directory in `packages/`. Public repository, so CI runs on GitHub-hosted
runners through `ultimatelemon/shared-actions` `@v1`, never on our own
runners.

## Scripts (root)

```bash
npm run build         # every package that has a build
npm run typecheck     # tsc against each package's tsconfig.test.json
npm run lint          # eslint, through the workspace's own eslint-config
npm run format:check  # prettier, through the workspace's own prettier-config
npm test              # vitest per package
```

`typecheck` and `test` build `crypto` first; other packages import its `dist/`.

## Releasing

- Bump `version` in a package's `package.json` and merge to `main`;
  `publish.yml` publishes whatever version is not on npm yet, after
  `code-quality.yml` passed.
- Trusted publishing (OIDC): the npm side is bound to the file name
  `publish.yml`. Renaming it breaks publishing for every package.
- A brand-new package needs its first version published by hand (README).
- Changing a package without bumping its version publishes nothing.

## Workflows

- `code-quality.yml`: pull requests, pushes to `main`, and `workflow_call`.
- `publish.yml` (`Publish`): npm releases.
- `storybook-deployment.yml`: `packages/ui` Storybook image to
  `ghcr.io/ultimatelemon/ui-storybook`, deployed by Dokploy to
  `ui.ultimatelemon.eu` (secret `DOKPLOY_STORYBOOK_DEPLOY_URL`).

## Quirks

- `tools/icons` builds Font Awesome Pro packages that must never be published
  publicly; it lives outside `packages/*` on purpose.
- npm on Node 26 skips dependency install scripts not listed under
  `allowScripts` in the root `package.json`.
- Raising a package's `engines` or peer ranges is a breaking change for every
  consumer; bump the major.
