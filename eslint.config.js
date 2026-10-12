// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'admin/dist/**', 'node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      'security/detect-object-injection': 'off',
    },
  },
  {
    // Type-aware TS rules only apply to the backend project. Root JS configs and the .cjs
    // migrations stay on plain linting because they are outside a TS project.
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
    },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The admin has a separate tsconfig and is typechecked by admin:typecheck/admin:build. Keep its
    // ESLint rules non-type-aware so lint-staged can check CMS files without applying backend-only
    // strict rules to the existing frontend codebase.
    files: ['admin/src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  prettier,
);
