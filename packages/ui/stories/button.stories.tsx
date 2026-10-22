import type { Meta, StoryObj } from '@storybook/react-vite';
import { faArrowRight, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button } from '../src/index.js';

const meta = {
  title: 'Button',
  component: Button,
  args: { children: 'Doorgaan' },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'secondary',
        'outline',
        'ghost',
        'destructive',
        'link'
      ]
    },
    size: {
      control: 'select',
      options: ['default', 'sm', 'lg', 'icon', 'icon-sm']
    }
  }
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
    </div>
  )
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
    </div>
  )
};

// The kit ships no icons; apps pass their own Font Awesome Pro icon as a child.
export const WithIcon: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Button>
        Verder <FontAwesomeIcon icon={faArrowRight} />
      </Button>
      <Button variant="destructive">
        <FontAwesomeIcon icon={faTrash} /> Verwijderen
      </Button>
      <Button variant="outline" size="icon" aria-label="Verwijderen">
        <FontAwesomeIcon icon={faTrash} />
      </Button>
    </div>
  )
};

export const Disabled: Story = { args: { disabled: true } };
