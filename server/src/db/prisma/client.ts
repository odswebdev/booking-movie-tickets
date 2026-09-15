import { PrismaClient } from "../../generated/prisma/index.js";

/**
 * Lazily created: importing this module never opens a connection, and JSON
 * mode (DATABASE_URL unset) never constructs the client at all.
 */
let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export type { PrismaClient };
