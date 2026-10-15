import { loadConfig } from "./config.js";
import { PostgresStore } from "./store.js";

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("DATABASE_URL is required for migrate");
  process.exit(1);
}
const store = new PostgresStore(config.databaseUrl);
await store.migrate();
console.log("v2 schema applied");
process.exit(0);
