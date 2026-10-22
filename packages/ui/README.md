# @ultimatelemon-eu/ui

The UltimateLemon theme and a small set of shadcn-style React components, for
Tailwind 4. The components only use semantic variables (`--primary`,
`--background`, `--radius`), so a project can restyle them by overriding those.

```bash
npm install @ultimatelemon-eu/ui
```

```css
@import 'tailwindcss';
@import '@ultimatelemon-eu/ui/theme.css';
```

```tsx
import { Button } from '@ultimatelemon-eu/ui';

<Button>Doorgaan</Button>;
```

The theme also points Tailwind at the package's own files, so the component
classes end up in your CSS without any `@source` of your own.

[BRAND.md](./BRAND.md) has the rules: fonts, colour use, project overrides and
icons. It ships in the package, so a project's `CLAUDE.md` can point at
`node_modules/@ultimatelemon-eu/ui/BRAND.md`.

## Components

`Button`, `Input`, `Label`, `Card` (with `CardHeader`, `CardTitle`,
`CardDescription`, `CardAction`, `CardContent`, `CardFooter`) and `Badge`, plus
`cn` to merge class names.

## Icons

The kit ships no icons. We use Font Awesome Pro, and its licence does not
allow redistributing the Pro files in a public package, so a component that
needs an icon takes it as a child or prop.

## Storybook

```bash
npm run storybook --workspace @ultimatelemon-eu/ui
```

The toolbar switches between light, dark and the system setting. The stories
use Font Awesome Free so they run without a token.
