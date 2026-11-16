'use client';

import * as React from 'react';
import { cn } from './cn.js';

export interface AppShellNavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  /** Sub-pages, listed under the item while it or one of them is open. */
  children?: AppShellNavItem[];
}

export interface AppShellNavGroup {
  label?: string;
  items: AppShellNavItem[];
}

export interface AppShellLinkProps {
  href: string;
  className?: string;
  title?: string;
  'aria-current'?: 'page';
  'aria-label'?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}

export type AppShellLink = React.ComponentType<AppShellLinkProps>;

export interface AppShellIcons {
  menu: React.ReactNode;
  close: React.ReactNode;
  collapse: React.ReactNode;
  chevron: React.ReactNode;
}

export interface AppShellState {
  collapsed: boolean;
}

type Slot = React.ReactNode | ((state: AppShellState) => React.ReactNode);

export interface AppShellProps {
  nav: AppShellNavGroup[];
  pathname: string;
  logo: React.ReactNode;
  /** Shown instead of the logo in the collapsed icon rail. */
  logoMark?: React.ReactNode;
  logoHref?: string;
  logoLabel: string;
  sidebarTop?: Slot;
  sidebarFooter?: Slot;
  /** The router's link, such as Next.js `Link`; a plain `<a>` without one. */
  linkComponent?: AppShellLink;
  defaultCollapsed?: boolean;
  /** Remembers the rail in this cookie, so the server can render it. */
  collapseCookie?: string;
  icons?: Partial<AppShellIcons>;
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
}

function Anchor(props: AppShellLinkProps) {
  return <a {...props} />;
}

function Svg({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

const DEFAULT_ICONS: AppShellIcons = {
  menu: <Svg d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  close: <Svg d="M4 4l8 8M12 4l-8 8" />,
  collapse: <Svg d="M2.5 3.5h11v9h-11zM6.5 3.5v9" />,
  chevron: <Svg d="M6 4l4 4-4 4" />
};

export function isNavActive(pathname: string, href: string): boolean {
  return href === '/'
    ? pathname === '/'
    : pathname === href || pathname.startsWith(`${href}/`);
}

function render(slot: Slot | undefined, state: AppShellState) {
  return typeof slot === 'function' ? slot(state) : slot;
}

const ITEM =
  'relative flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 font-medium whitespace-nowrap text-foreground/70 hover:bg-sidebar-active/60 hover:text-foreground';
const ITEM_ACTIVE =
  'bg-sidebar-active text-foreground shadow-[0_1px_2px_var(--shadow-color)] ring-1 ring-border';

export function AppShell({
  nav,
  pathname,
  logo,
  logoMark,
  logoHref = '/',
  logoLabel,
  sidebarTop,
  sidebarFooter,
  linkComponent: Link = Anchor,
  defaultCollapsed = false,
  collapseCookie,
  icons,
  className,
  contentClassName,
  children
}: AppShellProps) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  // Below md the nav lives in a menu under the top bar.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const scroller = React.useRef<HTMLDivElement>(null);
  const icon = { ...DEFAULT_ICONS, ...icons };
  const state = { collapsed };

  React.useEffect(() => {
    if (!collapseCookie) return;
    document.cookie = `${collapseCookie}=${collapsed ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
  }, [collapsed, collapseCookie]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenuOpen(false);
      if (event.key.toLowerCase() === 'b' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The shell outlives navigation, so a new page starts at the top.
  React.useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
    setMenuOpen(false);
  }, [pathname]);

  function badge(item: AppShellNavItem) {
    if (item.badge === undefined || item.badge === null) return null;
    return (
      <span
        className={cn(
          'ml-auto shrink-0',
          collapsed && 'md:absolute md:-top-1 md:-right-1 md:scale-75'
        )}
      >
        {item.badge}
      </span>
    );
  }

  function subLinks(item: AppShellNavItem) {
    if (!item.children || !isNavActive(pathname, item.href)) return null;
    return (
      <div
        className={cn('flex flex-col gap-0.5 pl-4', collapsed && 'md:hidden')}
      >
        {item.children.map((child) => {
          const active = isNavActive(pathname, child.href);
          return (
            <Link
              key={child.href}
              href={child.href}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
              className={cn(ITEM, active && ITEM_ACTIVE)}
            >
              {child.icon ? (
                <span
                  className={cn(
                    'grid size-4 shrink-0 place-items-center',
                    active ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {child.icon}
                </span>
              ) : null}
              <span className="truncate">{child.label}</span>
              {badge(child)}
            </Link>
          );
        })}
      </div>
    );
  }

  function navLink(item: AppShellNavItem) {
    const open = isNavActive(pathname, item.href);
    // A parent with sub-pages only highlights the open sub-page.
    const active = open && !item.children;
    return (
      <Link
        href={item.children?.[0]?.href ?? item.href}
        title={collapsed ? item.label : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={() => setMenuOpen(false)}
        className={cn(
          ITEM,
          active && ITEM_ACTIVE,
          open && item.children && 'text-foreground',
          // The icon rail hides the sub-pages, so the parent stands in.
          open &&
            item.children &&
            collapsed &&
            'md:bg-sidebar-active md:ring-1 md:ring-border',
          collapsed && 'md:justify-center md:px-0'
        )}
      >
        {item.icon ? (
          <span
            className={cn(
              'grid size-4 shrink-0 place-items-center',
              active ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {item.icon}
          </span>
        ) : null}
        <span className={cn('truncate', collapsed && 'md:sr-only')}>
          {item.label}
        </span>
        {badge(item)}
        {item.children ? (
          <span
            aria-hidden="true"
            className={cn(
              'text-muted-foreground transition-transform duration-150',
              item.badge === undefined && 'ml-auto',
              open && 'rotate-90',
              collapsed && 'md:hidden'
            )}
          >
            {icon.chevron}
          </span>
        ) : null}
      </Link>
    );
  }

  return (
    <div
      data-slot="app-shell"
      className={cn('flex min-h-dvh flex-col bg-frame md:flex-row', className)}
    >
      <aside
        className={cn(
          'relative z-40 flex shrink-0 items-center gap-1 px-2 py-2 transition-[width] duration-200 md:sticky md:top-0 md:h-dvh md:flex-col md:items-stretch md:gap-0.5 md:overflow-y-auto',
          collapsed ? 'md:w-16 md:px-2' : 'md:w-60 md:pr-2.5 md:pl-3'
        )}
      >
        <div
          className={cn(
            'flex h-12 shrink-0 items-center gap-2 px-2 md:mb-1',
            collapsed && 'md:justify-center md:px-0'
          )}
        >
          <Link
            href={logoHref}
            aria-label={logoLabel}
            className="flex items-center"
          >
            {collapsed && logoMark ? (
              <>
                <span className="hidden md:contents">{logoMark}</span>
                <span className="contents md:hidden">{logo}</span>
              </>
            ) : (
              logo
            )}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label="Collapse sidebar"
            aria-expanded={!collapsed}
            title="Collapse sidebar (⌘B)"
            className={cn(
              'ml-auto hidden size-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-active hover:text-foreground md:grid',
              collapsed && 'md:hidden'
            )}
          >
            {icon.collapse}
          </button>
        </div>

        {menuOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-black/30 md:hidden"
          />
        ) : null}

        <div
          id="app-shell-nav"
          className={cn(
            'flex-col gap-0.5 md:static md:z-auto md:flex md:max-h-none md:flex-1 md:overflow-visible md:border-0 md:bg-transparent md:p-0 md:shadow-none',
            menuOpen
              ? 'absolute inset-x-2 top-full z-40 flex max-h-[calc(100dvh-4.5rem)] overflow-y-auto rounded-xl border bg-panel p-2 shadow-card'
              : 'hidden'
          )}
        >
          {sidebarTop ? (
            <div className="mb-1 shrink-0">{render(sidebarTop, state)}</div>
          ) : null}
          <nav aria-label="Main" className="flex flex-col gap-0.5">
            {nav.map((group, index) => (
              <div
                key={group.label ?? `group-${index}`}
                className="flex flex-col gap-0.5"
              >
                {group.label ? (
                  <div
                    className={cn(
                      'px-2.5 pt-4 pb-1 text-[11px] font-semibold text-muted-foreground',
                      collapsed && 'md:hidden'
                    )}
                  >
                    {group.label}
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <React.Fragment key={item.href}>
                    {navLink(item)}
                    {subLinks(item)}
                  </React.Fragment>
                ))}
              </div>
            ))}
          </nav>
          {sidebarFooter ? (
            <div className="mt-3 flex shrink-0 flex-col gap-2 md:mt-auto md:pt-3">
              {render(sidebarFooter, state)}
            </div>
          ) : null}
        </div>

        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            aria-expanded={false}
            title="Expand sidebar (⌘B)"
            className="hidden h-8 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-active hover:text-foreground md:grid"
          >
            {icon.collapse}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="app-shell-nav"
          className="relative ml-auto grid size-9 place-items-center rounded-lg text-foreground/80 hover:bg-sidebar-active hover:text-foreground md:hidden"
        >
          {menuOpen ? icon.close : icon.menu}
        </button>
      </aside>

      <main className="mx-2 mb-2 min-w-0 flex-1 overflow-clip rounded-xl border border-panel-border bg-panel shadow-[0_1px_2px_var(--shadow-color)] md:my-2 md:ml-0 md:flex md:h-[calc(100dvh-1rem)] md:flex-col">
        <div
          ref={scroller}
          className="md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain"
        >
          <div
            className={cn(
              'flex flex-col gap-5 px-4 pb-9 md:px-7',
              contentClassName
            )}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The breadcrumb for a page: the group, the open nav item and, below it, the
 * open sub-page or `leaf` (a detail page's own name).
 */
export function navTrail(
  nav: AppShellNavGroup[],
  pathname: string,
  leaf?: string
): Crumb[] {
  for (const group of nav) {
    for (const item of group.items) {
      if (!isNavActive(pathname, item.href)) continue;
      const trail: Crumb[] = group.label ? [{ label: group.label }] : [];
      const child = item.children?.find((c) => isNavActive(pathname, c.href));
      const deepest = child ?? item;
      if (child) trail.push({ label: item.label, href: item.href });
      if (pathname === deepest.href && !leaf) {
        trail.push({ label: deepest.label });
      } else {
        trail.push({ label: deepest.label, href: deepest.href });
        if (leaf) trail.push({ label: leaf });
      }
      return trail;
    }
  }
  return leaf ? [{ label: leaf }] : [];
}

export interface PageHeaderProps {
  trail: Crumb[];
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Beside the title, such as a primary action or a source link. */
  actions?: React.ReactNode;
  /** Right side of the breadcrumb bar, which stays put while the page scrolls. */
  barActions?: React.ReactNode;
  linkComponent?: AppShellLink;
  className?: string;
}

// Spans the panel edge to edge: AppShell's content padding is cancelled here.
export function PageHeader({
  trail,
  title,
  description,
  actions,
  barActions,
  linkComponent: Link = Anchor,
  className
}: PageHeaderProps) {
  return (
    <>
      <nav
        aria-label="Breadcrumb"
        data-slot="page-header-bar"
        className="sticky top-0 z-20 -mx-4 flex min-h-12 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-panel px-4 py-2 md:-mx-7 md:px-7"
      >
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <React.Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-muted-foreground/40">
                  /
                </span>
              ) : null}
              {last ? (
                <span aria-current="page" className="truncate font-semibold">
                  {crumb.label}
                </span>
              ) : crumb.href ? (
                <Link
                  href={crumb.href}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="shrink-0 text-muted-foreground">
                  {crumb.label}
                </span>
              )}
            </React.Fragment>
          );
        })}
        {barActions ? (
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
            {barActions}
          </div>
        ) : null}
      </nav>
      <header
        data-slot="page-header"
        className={cn(
          '-mx-4 -mt-5 flex flex-wrap items-end gap-x-4 gap-y-3 px-4 pt-6 md:-mx-7 md:px-7',
          className
        )}
      >
        <div className="min-w-0 flex-[1_1_320px]">
          <h1 className="font-display text-[28px] leading-[34px] font-bold tracking-[-0.02em] text-balance">
            {title}
          </h1>
          {description ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>
    </>
  );
}
