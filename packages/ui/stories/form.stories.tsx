import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label
} from '../src/index.js';

const meta = {
  title: 'Card'
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignIn: Story = {
  render: () => (
    <Card className="w-[400px]">
      <CardHeader>
        <CardTitle>Inloggen</CardTitle>
        <CardDescription>Met je UltimateLemon-account.</CardDescription>
        <CardAction>
          <Badge variant="secondary">Beta</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">E-mailadres</Label>
          <Input id="email" type="email" placeholder="jij@voorbeeld.nl" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Wachtwoord</Label>
          <Input id="password" type="password" aria-invalid />
          <p className="text-[13px] text-destructive">
            Dat wachtwoord klopt niet.
          </p>
        </div>
      </CardContent>
      <CardFooter className="flex-col">
        <Button className="w-full">Inloggen</Button>
        <Button variant="link" size="sm">
          Wachtwoord vergeten?
        </Button>
      </CardFooter>
    </Card>
  )
};

export const InputStates: Story = {
  render: () => (
    <div className="flex w-[320px] flex-col gap-3">
      <Input placeholder="Leeg" />
      <Input defaultValue="Ingevuld" />
      <Input defaultValue="Ongeldig" aria-invalid />
      <Input defaultValue="Uitgeschakeld" disabled />
    </div>
  )
};
