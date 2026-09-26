import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { dbConnection } from "./connection";
import * as schema from "./schema";

const { Pool } = pg;

const { target: _target, ...connection } = dbConnection();

export const pool = new Pool(connection);
export const db = drizzle(pool, { schema });

export * from "./schema";
