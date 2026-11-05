import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Toaster,
  cn
} from './index.js';

describe('cn', () => {
  it('lets a later class win over a conflicting one', () => {
    expect(cn('px-4', 'px-2')).toBe('px-2');
  });

  it('knows the theme tokens it adds to Tailwind', () => {
    expect(cn('text-link', 'text-primary')).toBe('text-primary');
    expect(cn('shadow-card', 'shadow-none')).toBe('shadow-none');
    expect(cn('font-display', 'font-sans')).toBe('font-sans');
  });

  it('keeps a size and a colour on text-*', () => {
    expect(cn('text-sm', 'text-link')).toBe('text-sm text-link');
  });
});

describe('Button', () => {
  it('renders the primary variant by default', () => {
    const html = renderToStaticMarkup(<Button>Verder</Button>);
    expect(html).toContain('<button');
    expect(html).toContain('data-variant="default"');
    expect(html).toContain('bg-primary');
  });

  it('lets className override a variant class', () => {
    const html = renderToStaticMarkup(<Button className="h-12">Verder</Button>);
    expect(html).toContain('h-12');
    expect(html).not.toContain('h-10');
  });

  it('renders its child instead of a button with asChild', () => {
    const html = renderToStaticMarkup(
      <Button asChild variant="link">
        <a href="/help">Help</a>
      </Button>
    );
    expect(html).toMatch(/^<a /);
    expect(html).toContain('text-link');
    expect(html).not.toContain('<button');
  });
});

describe('the other components', () => {
  it('render with their data-slot', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardTitle>Account</CardTitle>
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" type="email" />
        <Badge variant="outline">Nieuw</Badge>
      </Card>
    );
    for (const slot of ['card', 'card-title', 'label', 'input', 'badge']) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
  });
});

describe('DropdownMenu', () => {
  it('renders a trigger that announces the menu', () => {
    const html = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Uitloggen</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(html).toContain('data-slot="dropdown-menu-trigger"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-state="closed"');
  });
});

describe('AlertDialog', () => {
  it('renders a closed trigger and keeps the dialog out of the page', () => {
    const html = renderToStaticMarkup(
      <AlertDialog>
        <AlertDialogTrigger>Verwijderen</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Weet je het zeker?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    );
    expect(html).toContain('data-slot="alert-dialog-trigger"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('Weet je het zeker?');
  });
});

describe('Toaster', () => {
  it('renders the toast region', () => {
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain('aria-label="Notifications');
  });
});
