import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const DEFAULT_IGNORES = [
  '.next/**',
  'node_modules/**',
  'dist/**',
  'out/**',
  'build/**',
  'coverage/**',
  'next-env.d.ts'
];

const RELAXED_FILES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/__tests__/**',
  '**/seed.ts',
  '**/migrate.ts',
  '**/scripts/**'
];

export function config({
  rootDir,
  ignores = [],
  typeChecked = true,
  extra = []
} = {}) {
  if (typeChecked && !rootDir) {
    throw new Error(
      '@ultimatelemon/eslint-config: rootDir is required when typeChecked is on. Pass import.meta.dirname.'
    );
  }

  return tseslint.config(
    { ignores: [...DEFAULT_IGNORES, ...ignores] },

    ...nextCoreWebVitals,
    ...(typeChecked
      ? tseslint.configs.recommendedTypeChecked
      : tseslint.configs.recommended),

    {
      ...(typeChecked
        ? {
            languageOptions: {
              parserOptions: { projectService: true, tsconfigRootDir: rootDir }
            }
          }
        : {}),
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/explicit-module-boundary-types': 'warn',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
        ],
        'no-console': ['warn', { allow: ['warn', 'error', 'info'] }]
      }
    },

    {
      files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
      ...tseslint.configs.disableTypeChecked
    },

    {
      files: RELAXED_FILES,
      rules: {
        'no-console': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off'
      }
    },

    ...extra,

    prettier
  );
}

export default config;
