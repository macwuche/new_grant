import { defineConfig } from "drizzle-kit";
import path from "path";
import { dbConnection } from "./src/connection";

const { target, url, ...connection } = dbConnection();
console.log(`drizzle-kit: using the ${target} database (${connection.host})`);

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  // drizzle-kit exits silently on Replit's database with separate fields, so it gets the URL;
  // Supabase needs the fields so the pinned CA applies.
  dbCredentials: target === "supabase" ? connection : { url },
});
