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
`CardDescription`, `CardAction`, `CardContent`, `CardFooter`), `Badge` and
`DropdownMenu` (Radix, with items, checkbox and radio items, labels, shortcuts
and submenus; it animates in from the side it opens on), `AlertDialog` (Radix,
for confirmations; `AlertDialogAction` takes the `Button` variants) and
`Toaster` with `toast` (Sonner), plus `cn` to merge class names.

Mount `<Toaster />` once in the root layout, then call `toast('Saved')` or
`toast.error('…')` from any client component.

## App shell

`AppShell` is the dashboard layout: an inset sidebar on `--frame` with grouped
nav, badges and sub-pages, a collapsible icon rail (⌘B) and a menu below
`md`, and the page in a rounded panel on `--panel`. `PageHeader` adds the
sticky breadcrumb bar and the title; `navTrail` builds its breadcrumb from the
same nav. The shell does not know your router: pass the `pathname` and your
link component.

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AppShell, type AppShellNavGroup } from '@ultimatelemon-eu/ui';

const NAV: AppShellNavGroup[] = [
  {
    items: [
      { href: '/', label: 'Overview', icon: <FontAwesomeIcon icon={faHouse} /> }
    ]
  },
  {
    label: 'Changes',
    items: [{ href: '/plans', label: 'Plans', badge: <Badge>3</Badge> }]
  }
];

export function Shell({
  children,
  collapsed
}: {
  children: React.ReactNode;
  collapsed: boolean;
}) {
  return (
    <AppShell
      nav={NAV}
      pathname={usePathname()}
      linkComponent={Link}
      logo={
        <img src="/logo.png" alt="UltimateLemon" className="h-[26px] w-auto" />
      }
      logoLabel="Overview"
      defaultCollapsed={collapsed}
      collapseCookie="myapp_sidebar"
      sidebarFooter={({ collapsed }) => (collapsed ? null : <UserMenu />)}
    >
      {children}
    </AppShell>
  );
}
```

Read the cookie on the server to pass `defaultCollapsed`, so the rail renders
in the right state. Its colours are `--frame`, `--panel`, `--panel-border` and
`--sidebar-active`; override them like any other token.

## Icons

The kit ships no icons. We use Font Awesome Pro, and its licence does not
allow redistributing the Pro files in a public package, so a component that
needs an icon takes it as a child or prop.

## Storybook

Live at <https://ui.ultimatelemon.eu>, rebuilt on every push to `packages/ui/`
(`.github/workflows/storybook-deployment.yml`). Locally:

```bash
npm run storybook --workspace @ultimatelemon-eu/ui
```

The toolbar switches between light, dark and the system setting. The stories
use Font Awesome Free so they run without a token.
