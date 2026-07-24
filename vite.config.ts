import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";

const RELAY_DATABASE_ID = "8621bc6b-2324-495e-97f3-3b72f2e4f1af";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  d1_databases: [
    {
      binding: "DB",
      database_name: "relay-db",
      database_id: RELAY_DATABASE_ID,
    },
  ],
  r2_buckets: [
    {
      binding: "CHECKPOINTS",
      bucket_name: "relay-checkpoints",
    },
  ],
};

export default defineConfig(async ({ command, mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const localEnvironment =
    command === "serve" ? loadEnv(mode, process.cwd(), "") : {};

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        // Wrangler bindings, not Node's process.env, are visible inside
        // workerd. Forward local values only during `vinext dev` so secrets
        // can never be serialized into production build output. Production
        // builds read the checked-in wrangler.jsonc instead.
        ...(command === "serve"
          ? {
              config: {
                ...localBindingConfig,
                vars: localWorkerVars(localEnvironment),
              },
            }
          : {}),
      }),
    ],
  };
});

function localWorkerVars(
  localEnvironment: Record<string, string>,
): Record<string, string> {
  const keys = [
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "RELAY_LOCAL_PREVIEW",
    "VIBELOFT_PRODUCT_ID",
    "VIBELOFT_WEB_AUTH_KEY",
  ] as const;

  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = process.env[key] ?? localEnvironment[key];
      return value ? [[key, value]] : [];
    }),
  );
}
