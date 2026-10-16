/**
 * First lint pass on a previously-unlinted codebase — kept intentionally
 * conservative (warnings, not errors) on rules likely to flag a lot of
 * pre-existing code, so this can land without a separate mass-cleanup PR.
 * Tighten to "error" incrementally as the backlog is worked down.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    es2022: true
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js', '*.cjs'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-var-requires': 'warn',
    'no-unused-vars': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-constant-condition': ['warn', { checkLoops: false }]
  },
  overrides: [
    {
      // Engine layer (v0.26.0, docs/mcp-engine-requirements.md §4.4): runs in the
      // extension host today and in the standalone MCP server from Phase 3, so it
      // must never depend on the VS Code API — not even for types.
      files: ['src/engine/**/*.ts', 'src/mcp/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [{ name: 'vscode', message: 'src/engine and src/mcp must stay host-agnostic — take what you need through a parameter (see FileIo, AgentHost).' }]
        }]
      }
    }
  ]
};
