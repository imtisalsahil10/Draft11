/* Run from frontend with: npm run lint */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true
    }
  },
  settings: {
    react: {
      version: '18.2'
    }
  },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended'
  ],
  plugins: ['react', 'react-hooks'],
  ignorePatterns: ['dist/**', 'node_modules/**'],
  rules: {
    'react/prop-types': 'off',
    // Existing screens use apostrophes in visible sentences.
    'react/no-unescaped-entities': 'off'
  }
};
