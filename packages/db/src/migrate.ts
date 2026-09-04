import { loadConfig } from '@charter/config';
import { createDb } from './index.js';
import { migrateDatabase } from './migrations.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const result = await migrateDatabase(db);
  console.log(`migrate ok: applied=${result.applied.length} skipped=${result.skipped.length}`);
} finally {
  await db.destroy();
}
