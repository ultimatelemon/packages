import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  faArrowRightFromBracket,
  faGear,
  faUser
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../src/index.js';

const meta = {
  title: 'DropdownMenu'
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function AccountMenu() {
  const [theme, setTheme] = useState('system');
  const [compact, setCompact] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Account</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="start">
        <DropdownMenuLabel>Mijn account</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <FontAwesomeIcon icon={faUser} />
            Profiel
            <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <FontAwesomeIcon icon={faGear} />
            Instellingen
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem
            checked={compact}
            onCheckedChange={setCompact}
          >
            Compacte weergave
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Thema</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="system">
                Systeem
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Licht</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Donker</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <FontAwesomeIcon icon={faArrowRightFromBracket} />
          Uitloggen
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const Account: Story = {
  render: () => <AccountMenu />
};
