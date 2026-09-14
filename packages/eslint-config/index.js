import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import { build } from './shared.js';

export function config(options = {}) {
  return build({ ...options, framework: nextCoreWebVitals });
}

export default config;
