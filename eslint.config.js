import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.claude` guarda tooling y worktrees locales (con su propio `dist`
  // compilado): no es código fuente del proyecto y no debe lintarse.
  { ignores: ["**/dist/**", "node_modules", "coverage", ".claude"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
