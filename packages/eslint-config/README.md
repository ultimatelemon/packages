# @ultimatelemon/eslint-config

Next.js core-web-vitals, type-aware TypeScript rules, and `eslint-config-prettier`
last so formatting never fights the linter.

```bash
npm install -D @ultimatelemon/eslint-config eslint eslint-config-next \
  eslint-config-prettier typescript-eslint
```

```js
// eslint.config.mjs
import { config } from '@ultimatelemon/eslint-config';

export default config({ rootDir: import.meta.dirname });
```

## Options

| Option        | Default | Does                                                      |
| ------------- | ------- | --------------------------------------------------------- |
| `rootDir`     | —       | Required when type-aware; pass `import.meta.dirname`      |
| `ignores`     | `[]`    | Added to the defaults, not replacing them                 |
| `typeChecked` | `true`  | Turn off for a project without a TypeScript project graph |
| `extra`       | `[]`    | Config objects appended before `eslint-config-prettier`   |

## What it turns on

`no-explicit-any`, `no-floating-promises`, `await-thenable` and
`no-misused-promises` are errors: a forgotten `await` on a database write fails
silently, and `any` tends to appear exactly where types matter most.

`explicit-module-boundary-types` is a warning on exports only, and
`no-console` allows `warn`, `error` and `info`.

Tests, seeds, migrators and scripts are exempt from the console and return-type
rules.
