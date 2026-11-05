import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Toaster, toast } from '../src/index.js';

const meta = {
  title: 'Toaster'
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Kinds: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Toaster />
      <Button variant="outline" onClick={() => toast('Wijzigingen opgeslagen')}>
        Melding
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.success('Testbericht verstuurd', {
            description: 'Kijk of het is aangekomen.'
          })
        }
      >
        Gelukt
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.error('Verwijderen mislukt: geen verbinding')}
      >
        Fout
      </Button>
    </div>
  )
};
