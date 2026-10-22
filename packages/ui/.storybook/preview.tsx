import type { Preview } from '@storybook/react-vite';
import './storybook.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Light or dark',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'system', title: 'System' },
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' }
        ],
        dynamicTitle: true
      }
    }
  },
  initialGlobals: { theme: 'system' },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme as string;
      if (theme === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      return <Story />;
    }
  ],
  parameters: {
    layout: 'centered',
    backgrounds: { disable: true }
  }
};

export default preview;
