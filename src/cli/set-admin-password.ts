import { argon2id, hash } from 'argon2';
import { uuidv7 } from 'uuidv7';
import { db, closeDb } from '../db/index.js';

const email = process.argv[2]?.trim().toLowerCase();
const role = process.argv[3] ?? 'superadmin';
const password = process.env['ADMIN_NEW_PASSWORD'];
const roles = ['analyst', 'fulfillment', 'reviewer', 'superadmin'];

if (!email || !password || password.length < 12 || !roles.includes(role)) {
  process.stderr.write(
    'Usage: ADMIN_NEW_PASSWORD=<12+ chars> pnpm admin:set-password -- <email> [analyst|fulfillment|reviewer|superadmin]\n',
  );
  process.exitCode = 1;
} else {
  const passwordHash = await hash(password, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
  const existing = await db
    .selectFrom('admin_users')
    .select('id')
    .where((eb) => eb.fn('lower', ['email']), '=', email)
    .executeTakeFirst();

  if (existing) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admin_users')
        .set({
          email,
          role,
          password_hash: passwordHash,
          status: 'active',
          failed_login_count: 0,
          locked_until: null,
          password_changed_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      await trx
        .updateTable('admin_sessions')
        .set({ revoked_at: new Date() })
        .where('admin_user_id', '=', existing.id)
        .where('revoked_at', 'is', null)
        .execute();
    });
  } else {
    const adminUserId = uuidv7();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('admin_users')
        .values({
          id: adminUserId,
          email,
          role,
          password_hash: passwordHash,
          password_changed_at: new Date(),
        })
        .execute();
    });
  }
  process.stdout.write(`Admin credentials updated for ${email}\n`);
}

await closeDb();
