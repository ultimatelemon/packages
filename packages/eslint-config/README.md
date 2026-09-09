# @ultimatelemon-eu/eslint-config

Next.js core-web-vitals, type-aware TypeScript rules, and `eslint-config-prettier`
last so formatting never fights the linter.

```bash
npm install -D @ultimatelemon-eu/eslint-config eslint eslint-config-next \
  eslint-config-prettier typescript-eslint
```

```js
// eslint.config.mjs
import { config } from '@ultimatelemon-eu/eslint-config';

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

`no-misused-promises` does not check JSX attributes. An async `onClick` is how
React code is written, and flagging it in every handler drowns the cases the
rule is actually for: a promise in a condition, or dropped in a void context
outside JSX.

There is no `explicit-module-boundary-types`. It produced 47 findings in one
repository and 22 in another, none of which anyone was going to act on, and a
warning that never becomes an error is noise. TypeScript infers return types,
and the unsafe-value rules already catch the cases where that inference is
hiding an `any`.

Tests, seeds, migrators and scripts are exempt from the console and return-type
rules.
