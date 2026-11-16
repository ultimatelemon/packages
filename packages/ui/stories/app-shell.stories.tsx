import { createContext, useContext, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  faClockRotateLeft,
  faCodeBranch,
  faCodePullRequest,
  faDatabase,
  faFolder,
  faHouse,
  faShieldHalved,
  faWaveSquare
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  AppShell,
  Badge,
  Card,
  CardContent,
  PageHeader,
  navTrail,
  type AppShellLinkProps,
  type AppShellNavGroup
} from '../src/index.js';

const NAV: AppShellNavGroup[] = [
  {
    items: [
      { href: '/', label: 'Overview', icon: <FontAwesomeIcon icon={faHouse} /> }
    ]
  },
  {
    label: 'Changes',
    items: [
      {
        href: '/activity',
        label: 'Activity',
        icon: <FontAwesomeIcon icon={faClockRotateLeft} />
      },
      {
        href: '/plans',
        label: 'Plans',
        icon: <FontAwesomeIcon icon={faCodePullRequest} />,
        badge: <Badge variant="destructive">3</Badge>
      },
      {
        href: '/drift',
        label: 'Drift',
        icon: <FontAwesomeIcon icon={faWaveSquare} />,
        badge: <Badge>4</Badge>
      }
    ]
  },
  {
    label: 'Inventory',
    items: [
      {
        href: '/projects',
        label: 'Projects',
        icon: <FontAwesomeIcon icon={faFolder} />
      },
      {
        href: '/github',
        label: 'GitHub',
        icon: <FontAwesomeIcon icon={faCodeBranch} />
      },
      {
        href: '/zero-trust',
        label: 'Zero Trust',
        icon: <FontAwesomeIcon icon={faShieldHalved} />
      },
      {
        href: '/storage',
        label: 'Storage & SigNoz',
        icon: <FontAwesomeIcon icon={faDatabase} />
      }
    ]
  }
];

// Stands in for a router: links change the story's pathname instead of the page.
const Navigate = createContext<(href: string) => void>(() => {});

function Link({ href, onClick, ...props }: AppShellLinkProps) {
  const navigate = useContext(Navigate);
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
        onClick?.();
      }}
    />
  );
}

function Demo({ collapsed }: { collapsed: boolean }) {
  const [pathname, setPathname] = useState('/projects/kwil');

  const leaf = pathname.startsWith('/projects/') ? 'kwil' : undefined;
  return (
    <Navigate.Provider value={setPathname}>
      <AppShell
        nav={NAV}
        pathname={pathname}
        linkComponent={Link}
        defaultCollapsed={collapsed}
        logo={
          <span className="font-display text-lg font-bold">UltimateLemon</span>
        }
        logoMark={<span className="font-display text-lg font-bold">U</span>}
        logoLabel="Overview"
        sidebarFooter={({ collapsed: rail }) =>
          rail ? null : (
            <div className="rounded-lg border bg-panel px-3 py-2.5 text-xs">
              <div className="font-semibold">Stacks</div>
              <div className="text-muted-foreground">dns · drift 3</div>
            </div>
          )
        }
      >
        <PageHeader
          trail={navTrail(NAV, pathname, leaf)}
          title={
            leaf ??
            NAV.flatMap((g) => g.items).find((i) => i.href === pathname)
              ?.label ??
            ''
          }
          description="Every object links to its source file."
          barActions={<span>main @ 981ba97</span>}
          linkComponent={Link}
        />
        <Card>
          <CardContent>Content of {pathname}</CardContent>
        </Card>
      </AppShell>
    </Navigate.Provider>
  );
}

const meta = {
  title: 'AppShell',
  parameters: { layout: 'fullscreen' }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = { render: () => <Demo collapsed={false} /> };

export const Collapsed: Story = { render: () => <Demo collapsed /> };
