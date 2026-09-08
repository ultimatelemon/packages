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

To override a single option, point at the package from a `.prettierrc.mjs`:

```js
import base from '@ultimatelemon-eu/prettier-config' with { type: 'json' };

export default { ...base, printWidth: 100 };
```
