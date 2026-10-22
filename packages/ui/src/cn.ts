import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Without these, tailwind-merge does not see that text-link and text-primary conflict.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: ['link'],
      font: ['display'],
      shadow: ['card']
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
