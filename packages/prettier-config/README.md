# @ultimatelemon-eu/prettier-config

Single quotes, semicolons, no trailing commas, two spaces, 80 columns.

```bash
npm install -D @ultimatelemon-eu/prettier-config
```

```json
{
  "prettier": "@ultimatelemon-eu/prettier-config"
}
```

With Tailwind class sorting, which needs `prettier-plugin-tailwindcss`:

```json
{
  "prettier": "@ultimatelemon-eu/prettier-config/tailwind"
}
```

On Tailwind 4 the plugin needs the project's CSS entry to know theme tokens
such as those from `@ultimatelemon-eu/ui`; without it, their classes sort as
unknown. The path differs per project, so set it in a `.prettierrc.mjs`:

```js
import tailwind from '@ultimatelemon-eu/prettier-config/tailwind' with { type: 'json' };

const config = { ...tailwind, tailwindStylesheet: './src/app/globals.css' };

export default config;
```

To override a single option, point at the package from a `.prettierrc.mjs`:

```js
import base from '@ultimatelemon-eu/prettier-config' with { type: 'json' };

export default { ...base, printWidth: 100 };
```
