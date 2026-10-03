// This CLI stages only bytes; it never connects to a database.
import { stageDatabaseImport } from '../server/services/databaseImport.js';

try {
  const replay = await stageDatabaseImport(process.argv[2], process.argv[3], process.env.PORTOS_IMPORT_SHA256);
  process.stdout.write(replay + '\n');
} catch (err) {
  console.error(`❌ Could not stage database import: ${err.message}`);
  process.exitCode = 1;
}
