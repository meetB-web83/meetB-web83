// Shared ESLint flat config for the whole backend workspace. Each package's
// `lint` script runs `eslint src/` from its own directory and resolves this
// config by searching upward.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase deliberately uses `any` at JSON-RPC/HTTP boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      // TypeScript's own unused checks (noUnusedLocals) are stricter and
      // already enforced via `pnpm typecheck`.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
