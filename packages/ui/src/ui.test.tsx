import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Card, CardTitle, Input, Label, cn } from './index.js';

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
