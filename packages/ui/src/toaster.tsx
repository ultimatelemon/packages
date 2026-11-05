'use client';

import * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

// The theme's tokens are light-dark() pairs, so the toasts follow the colour
// scheme without Sonner's own theme switch.
const style = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)'
} as React.CSSProperties;

function Toaster({ toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      style={style}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: 'font-sans shadow-card!',
          description: 'text-muted-foreground!',
          ...toastOptions?.classNames
        }
      }}
      {...props}
    />
  );
}

export { Toaster };
export { toast } from 'sonner';
