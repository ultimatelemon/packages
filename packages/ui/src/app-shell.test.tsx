import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AppShell,
  PageHeader,
  cn,
  navTrail,
  type AppShellLinkProps,
  type AppShellNavGroup
} from './index.js';

const NAV: AppShellNavGroup[] = [
  { items: [{ href: '/', label: 'Overview' }] },
  {
    label: 'Changes',
    items: [
      { href: '/plans', label: 'Plans', badge: <b>3</b> },
      { href: '/drift', label: 'Drift' }
    ]
  },
  {
    label: 'Inventory',
    items: [
      {
        href: '/settings',
        label: 'Settings',
        children: [
          { href: '/settings/tokens', label: 'Tokens' },
          { href: '/settings/users', label: 'Users' }
        ]
      }
    ]
  }
];

function shell(pathname: string, extra = {}): string {
  return renderToStaticMarkup(
    <AppShell
      nav={NAV}
      pathname={pathname}
      logo={<span>Logo</span>}
      logoLabel="Home"
      {...extra}
    >
      <p>Page</p>
    </AppShell>
  );
}

describe('AppShell', () => {
  it('marks only the open item as the current page', () => {
    const html = shell('/drift');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/drift" aria-current="page"/);
  });

  it('opens Overview on / only', () => {
    expect(shell('/')).toMatch(/<a href="\/" aria-current="page"/);
    expect(shell('/plans')).not.toMatch(/<a href="\/" aria-current="page"/);
  });

  it('renders group labels, badges and the page', () => {
    const html = shell('/');
    expect(html).toContain('Changes');
    expect(html).toContain('<b>3</b>');
    expect(html).toContain('<p>Page</p>');
  });

  it('lists sub-pages only while their parent is open', () => {
    expect(shell('/')).not.toContain('Tokens');
    const html = shell('/settings/users');
    expect(html).toContain('Tokens');
    expect(html).toMatch(/<a href="\/settings\/users" aria-current="page"/);
    expect(html).toMatch(/<a href="\/settings\/tokens"/);
  });

  it('uses the given link component', () => {
    function Link(props: AppShellLinkProps) {
      return <a data-router="" {...props} />;
    }
    expect(shell('/', { linkComponent: Link })).toContain('data-router=""');
  });

  it('renders slots as nodes or as functions of the state', () => {
    const html = shell('/', {
      defaultCollapsed: true,
      sidebarTop: <i>search</i>,
      sidebarFooter: ({ collapsed }: { collapsed: boolean }) =>
        collapsed ? <i>rail</i> : <i>full</i>
    });
    expect(html).toContain('<i>search</i>');
    expect(html).toContain('<i>rail</i>');
    expect(html).toContain('aria-label="Expand sidebar"');
  });
});

describe('navTrail', () => {
  it('gives the group and the open item', () => {
    expect(navTrail(NAV, '/drift')).toEqual([
      { label: 'Changes' },
      { label: 'Drift' }
    ]);
  });

  it('links the item when a leaf follows', () => {
    expect(navTrail(NAV, '/plans/222', '#222')).toEqual([
      { label: 'Changes' },
      { label: 'Plans', href: '/plans' },
      { label: '#222' }
    ]);
  });

  it('goes through a sub-page', () => {
    expect(navTrail(NAV, '/settings/users')).toEqual([
      { label: 'Inventory' },
      { label: 'Settings', href: '/settings' },
      { label: 'Users' }
    ]);
  });

  it('has no group for an ungrouped item', () => {
    expect(navTrail(NAV, '/')).toEqual([{ label: 'Overview' }]);
  });
});

describe('PageHeader', () => {
  it('links every crumb but the last', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        trail={[
          { label: 'Inventory' },
          { label: 'Projects', href: '/p' },
          { label: 'kwil' }
        ]}
        title="kwil"
        barActions={<span>main @ 981ba97</span>}
      />
    );
    expect(html).toContain('<a href="/p"');
    expect(html).toMatch(/aria-current="page"[^>]*>kwil</);
    expect(html).toContain('main @ 981ba97');
    expect(html).toContain('<h1');
  });
});

describe('cn', () => {
  it('knows the shell tokens', () => {
    expect(cn('bg-panel', 'bg-card')).toBe('bg-card');
    expect(cn('border-panel-border', 'border-border')).toBe('border-border');
  });
});
