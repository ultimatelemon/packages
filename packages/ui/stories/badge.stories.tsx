import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../src/index.js';

const meta = {
  title: 'Badge',
  component: Badge,
  args: { children: 'Nieuw' }
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="destructive">Destructive</Badge>
    </div>
  )
};
