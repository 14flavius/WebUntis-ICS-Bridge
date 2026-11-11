import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

// Plain flat-config array instead of tseslint.config(): we don't use the
// `extends` shorthand, and tseslint's loosely typed `CompatibleConfig` items
// (rules?: object) trip IDE signature checks against the strictly typed
// helper parameter.
export default [
  { ignores: ['dist/**', '.cache/**', 'node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': hooks },
    rules: hooks.configs.recommended.rules,
  },
  {
    rules: {
      'no-nested-ternary': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
];
