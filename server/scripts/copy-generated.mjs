/**
 * tsc only emits compiled TypeScript — the generated Prisma client in
 * `src/generated/prisma` is plain JS plus query-engine binaries, so the
 * production build must copy it next to the compiled `db/prisma/client.js`
 * (`dist/server/src/generated/prisma`). Without this, `npm start` (and the
 * Docker image) crashes at boot with ERR_MODULE_NOT_FOUND even in JSON mode,
 * because the repository provider imports the client module eagerly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(serverRoot, "src", "generated");
const target = path.join(serverRoot, "dist", "server", "src", "generated");

if (!fs.existsSync(source)) {
  console.error("[copy-generated] src/generated is missing — run `npm run prisma:generate` first.");
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log(`[copy-generated] ${path.relative(serverRoot, source)} → ${path.relative(serverRoot, target)}`);
