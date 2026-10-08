import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

describe('reminders', () => {
  test('someone who owes nothing has no reminders', async () => {
    const { club, members: [sia] } = await clubWithWedMavericks();

    expect(await club.as(sia).query('select * from my_reminders()')).toEqual([]);
  });

  test('a WAM ends 45 minutes after it starts', async () => {
    const { club } = await clubWithWedMavericks();

    const [{ ends }] = await club.owner("select (wam_ends_at('2027-01-06 21:30+00') at time zone 'UTC')::text as ends");
    expect(ends).toBe('2027-01-06 22:15:00');
  });
});
