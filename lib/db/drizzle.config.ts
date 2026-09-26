import { defineConfig } from "drizzle-kit";
import path from "path";
import { dbConnection } from "./src/connection";

const { target, ...connection } = dbConnection();
console.log(`drizzle-kit: using the ${target} database (${connection.host})`);

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: connection,
});
