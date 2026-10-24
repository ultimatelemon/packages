# icons

Builds private npm packages from a Font Awesome Pro web download, one package
per style, so a project installs only the styles it uses.

| Package                                   | Style           |
| ----------------------------------------- | --------------- |
| `@ultimatelemon-eu/icons-solid`           | classic solid   |
| `@ultimatelemon-eu/icons-regular`         | classic regular |
| `@ultimatelemon-eu/icons-brands`          | brands          |
| `@ultimatelemon-eu/icons-sharp-solid`     | sharp solid     |
| `@ultimatelemon-eu/icons-sharp-regular`   | sharp regular   |
| `@ultimatelemon-eu/icons-duotone-solid`   | duotone solid   |
| `@ultimatelemon-eu/icons-duotone-regular` | duotone regular |
| `@ultimatelemon-eu/icons-pixel-regular`   | pixel regular   |

The package version is the Font Awesome version. Add a style in `STYLES` in
`generate.ts`.

Font Awesome Pro may not be redistributed, so the packages are published with
restricted access and are never committed: the output lands in the ignored
`dist/`, and this directory sits outside `packages/*` so the public publish
workflow does not see it.

## Releasing a new Font Awesome version

Download the web zip from fontawesome.com, then:

```bash
npm login
npm run icons:build -- ~/Downloads/fontawesome-pro-plus-7.3.1-web.zip
npm run icons:publish -- --otp=<code>
```

## Using it

A project needs an npm token with read access to the org in its `.npmrc`
(`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`), also in CI and the Docker
build.

```bash
npm install @ultimatelemon-eu/icons-duotone-regular @fortawesome/fontawesome-svg-core @fortawesome/react-fontawesome
```

```tsx
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHouse } from '@ultimatelemon-eu/icons-duotone-regular';

<FontAwesomeIcon icon={faHouse} />;
```
