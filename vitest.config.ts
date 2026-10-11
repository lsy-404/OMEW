import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      vue: fileURLToPath(
        new URL(
          "./web/node_modules/vue/dist/vue.runtime.esm-bundler.js",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./server/wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only fixture value, not a production secret - see server/.dev.vars.example.
          DEV_TOKEN_SECRET: "test-secret-do-not-use-in-prod",
          // Pins the default test env to the "local" placeholder (matching every
          // existing @user:local assertion) rather than wrangler.jsonc's real
          // INSTANCE_DOMAIN - instance-domain.test.ts overrides this per-test to
          // exercise the actual derivation path.
          INSTANCE_DOMAIN: "local",
        },
      },
    }),
  ],
});
