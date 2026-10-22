# UltimateLemon brand

Rules for building UI in an UltimateLemon project. Written for people and for
coding agents; if you are an agent, follow these before your own defaults.

## Setup

```css
/* src/app/globals.css */
@import 'tailwindcss';
@import '@ultimatelemon-eu/ui/theme.css';
```

```tsx
// src/app/layout.tsx
import { Bricolage_Grotesque, Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage'
});

// <html className={`${inter.variable} ${bricolage.variable}`}>
```

## Components

Import from `@ultimatelemon-eu/ui` first: `Button`, `Input`, `Label`, `Card`
(with `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`,
`CardContent`, `CardFooter`), `Badge` and `cn`.

- Need something the kit lacks? Add it with the shadcn CLI in the project. It
  uses the same variables, so it matches without changes.
- A one-off tweak goes in `className`; `cn` lets it win over the component's
  own classes.
- Used the same tweak three times? Wrap the component in the project, or
  propose it for the kit.

## Colours

Use the semantic utilities, never hex codes or Tailwind's palette
(`bg-zinc-100`, `text-gray-500`):

| Utility                                  | For                                                   |
| ---------------------------------------- | ----------------------------------------------------- |
| `bg-background` / `text-foreground`      | the page                                              |
| `bg-card`                                | anything raised: cards, dialogs, menus                |
| `bg-primary` / `text-primary-foreground` | the one main action on a screen (lemon)               |
| `bg-secondary`, `bg-muted`, `bg-accent`  | quiet surfaces, hover states                          |
| `text-muted-foreground`                  | secondary text                                        |
| `text-link`                              | text links and anything yellow that has to be legible |
| `text-destructive`, `bg-destructive/10`  | errors and destructive actions                        |
| `border-border`, `border-input`          | dividers; form field outlines                         |

- Never put lemon (`primary`) as text or a thin line on a light background: it
  is barely 1.5:1. Use `text-link`.
- One primary button per screen. The rest is `outline`, `ghost` or `link`.
- Dark mode comes from the tokens. Do not write `dark:` variants for colours.
  `data-theme="light"` or `"dark"` on `<html>` forces a mode; without it the
  system setting decides.

## Project colours

A product with its own colours overrides the variables in its own CSS, after
the import. Each colour is one `light-dark()` pair, so one line covers both
modes:

```css
:root {
  --primary: light-dark(#5b54e0, #8b85ff);
  --primary-foreground: #fff;
}
```

Project colours, fonts and logos stay in the project, never in this package.

## Type

- Inter (`font-sans`) for everything; it is the body default.
- Bricolage Grotesque (`font-display`) for headings. `h1` to `h3` get it
  automatically.
- Sentence case for buttons and headings: "Account aanmaken", not "Account
  Aanmaken".

## Icons

Font Awesome Pro, via `@fortawesome/react-fontawesome`.

- Style: `regular`. Use `solid` only for emphasis, such as an active state.
- Import each icon (`import { faArrowRight } from '@fortawesome/pro-regular-svg-icons'`),
  never the whole library.
- Do not add Lucide, Heroicons or another icon set, also not when a shadcn
  component imports one: swap it for the Font Awesome equivalent.
- An icon-only button needs an `aria-label`.
- Pro needs the Font Awesome token. In a Dockerfile pass it as a build secret
  (`RUN --mount=type=secret,id=fontawesome ...`), never as an `ARG`: an `ARG`
  stays readable in the image history.

## Shape

- Radius comes from `--radius` (10px): `rounded-lg` for buttons and fields,
  `rounded-xl` for cards. Do not mix in `rounded-2xl` or `rounded-full`
  except for badges and avatars.
- Cards use `shadow-card` and a `border`. No other shadows.
