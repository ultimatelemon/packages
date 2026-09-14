import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export const DEFAULT_IGNORES = [
  '.next/**',
  'node_modules/**',
  'dist/**',
  'out/**',
  'build/**',
  'coverage/**',
  'next-env.d.ts'
];

export const RELAXED_FILES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/__tests__/**',
  '**/seed.ts',
  '**/migrate.ts',
  '**/scripts/**'
];

export function build({
  framework = [],
  rootDir,
  ignores = [],
  typeChecked = true,
  extra = []
} = {}) {
  if (typeChecked && !rootDir) {
    throw new Error(
      '@ultimatelemon-eu/eslint-config: rootDir is required when typeChecked is on. Pass import.meta.dirname.'
    );
  }

  return tseslint.config(
    { ignores: [...DEFAULT_IGNORES, ...ignores] },

    ...framework,
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
        '@typescript-eslint/no-misused-promises': [
          'error',
          { checksVoidReturn: { attributes: false } }
        ],
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
        'no-console': 'off'
      }
    },

    ...extra,

    prettier
  );
}
