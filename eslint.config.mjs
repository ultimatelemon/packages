import { config } from './packages/eslint-config/base.js';

// The packages' own tsconfig.json leaves out the tests, so lint against the
// test configs, which cover both.
export default config({
  rootDir: import.meta.dirname,
  ignores: ['**/dist/**', '**/storybook-static/**'],
  extra: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parserOptions: {
          projectService: false,
          project: [
            'packages/*/tsconfig.test.json',
            'tools/icons/tsconfig.json'
          ]
        }
      }
    }
  ]
});
