import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/coverage/**',
      'packages/db/migrations/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.drift-probe/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'log', 'table'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // NestJS DI resolves constructor parameter types at runtime: they must stay value imports.
    files: ['apps/api/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: ['apps/*-admin/**/*.tsx', 'packages/ui/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Module boundaries (ADR-004): UI code never imports server-only packages.
    files: ['apps/merchant-admin/**', 'apps/platform-admin/**', 'packages/ui/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@uc/db', '@uc/db/*', 'pg', 'drizzle-orm*'] }] },
  },
  prettier,
);
