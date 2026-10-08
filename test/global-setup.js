// Builds the fully migrated club database once for the whole run and
// saves it, so each test worker starts from that copy instead of
// re-applying every migration itself.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMigratedSnapshot } from './harness.js';

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'club-db-'));
  const file = join(dir, 'migrated.tar');
  const snapshot = await buildMigratedSnapshot();
  writeFileSync(file, Buffer.from(await snapshot.arrayBuffer()));
  process.env.CLUB_DB_SNAPSHOT = file;
  return () => rmSync(dir, { recursive: true, force: true });
}
