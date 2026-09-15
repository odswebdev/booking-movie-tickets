import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The datastore and the `env` module are singletons: each file must get a
    // fresh process (otherwise one file's process.env is parsed for all of
    // them) and they must not run in parallel.
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.d.ts"],
    },
  },
});
