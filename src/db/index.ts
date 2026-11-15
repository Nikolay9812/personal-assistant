import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// HTTP driver: one-shot queries over the pooled connection string, no pool to manage.
export const db = drizzle({ client: neon(databaseUrl), schema });
export * from "./schema.js";
