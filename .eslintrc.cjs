// Root ESLint config (ESLint 8.x / eslintrc style — matches the installed eslint@^8.57.0).
// Covers TS + React sources under packages/*/src and packages/adapters/*/src via
// the root "lint" script: eslint packages --ext .ts,.tsx
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    browser: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  rules: {
    // Mirrors tsconfig noUnusedLocals/noUnusedParameters; _-prefix opts out,
    // matching the usual TS convention for intentionally unused args.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
};
