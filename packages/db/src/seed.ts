import { loadConfig } from '@charter/config';
import { createDb } from './index.js';
import { seedDatabase } from './migrations.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  await seedDatabase(db);
  console.log('seed ok: northstar-demo-in, indigo-desk-in, harbor-spice-in');
} finally {
  await db.destroy();
}
