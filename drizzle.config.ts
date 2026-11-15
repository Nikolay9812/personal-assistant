import { defineConfig } from "drizzle-kit";

// `drizzle-kit push` runs over the direct (non-pooled) connection.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
