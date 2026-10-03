import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

describe('member privacy', () => {
  test('a newly registered member can see their own profile', async () => {
    const club = await freshClub();
    const alice = await club.register({ email: 'alice@example.com', fullName: 'Alice' });

    const rows = await club.as(alice).query('select full_name from profiles');

    expect(rows).toEqual([{ full_name: 'Alice' }]);
  });

  test("a member cannot read another member's plan", async () => {
    const club = await freshClub();
    const alice = await club.register({ email: 'alice@example.com', fullName: 'Alice' });
    const bob = await club.register({ email: 'bob@example.com', fullName: 'Bob' });
    await club.as(alice).query(
      "insert into plan_data (user_id, key, data) values ($1, 'goals', '[\"Run a marathon\"]')",
      [alice.id]
    );

    const seenByBob = await club.as(bob).query('select key from plan_data');
    const seenByAlice = await club.as(alice).query('select key from plan_data');

    expect(seenByBob).toEqual([]);
    expect(seenByAlice).toEqual([{ key: 'goals' }]);
  });
});
