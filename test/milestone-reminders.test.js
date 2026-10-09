import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

// Season 24 running in week `week`, and (optionally) Season 25 after it.
async function club({ week, next = null }) {
  const c = await freshClub();
  const manager = await c.register({ email: 'manager@example.com', fullName: 'Manager' });
  await c.makeClubManager(manager);
  const sia = await c.register({ email: 'sia@example.com', fullName: 'Sia' });
  const [s24] = await c.owner(
    "insert into cycles (name, start_date, status) values ('Season 24', current_date - 7 * ($1::int - 1), 'active') returning id, start_date::text",
    [week]);
  let s25 = null;
  if (next) {
    [s25] = await c.owner(
      "insert into cycles (name, start_date, status) values ('Season 25', $1::date + 91, $2) returning id", [s24.start_date, next]);
  }
  return { club: c, manager, sia, s24, s25 };
}
const milestones = (c, person) => c.as(person).query(
  "select message, role, overdue from my_reminders() where kind like 'milestone_%' order by kind");

describe('season milestone reminders', () => {
  test('no next season by week 10', async () => {
    const { club: c, manager } = await club({ week: 10 });

    expect(await milestones(c, manager)).toEqual([
      { message: 'Season 24 is in week 10 and no season after it has been created yet.', role: 'manager', overdue: false },
    ]);
  });

  test('enrolment due to open within 7 days, and overdue once the date passes', async () => {
    const soon = await club({ week: 10, next: 'setup' });
    const late = await club({ week: 12, next: 'setup' });

    expect([await milestones(soon.club, soon.manager), await milestones(late.club, late.manager)]).toEqual([
      [{ message: 'Enrolment for Season 25 is due to open in 7 days.', role: 'manager', overdue: false }],
      [{ message: 'Enrolment for Season 25 is due to open 7 days ago.', role: 'manager', overdue: true }],
    ]);
  });

  test('enrolment due to close within 7 days', async () => {
    const { club: c, manager } = await club({ week: 12, next: 'enrolling' });
    await c.owner("update cycles set enrolment_closes_on = current_date + 7 where name = 'Season 25'");

    expect(await milestones(c, manager)).toEqual([
      { message: 'Enrolment for Season 25 is due to close in 7 days.', role: 'manager', overdue: false },
    ]);
  });

  test("week 13, and members don't see milestones", async () => {
    const { club: c, manager, sia } = await club({ week: 13, next: 'enrolling' });
    await c.owner("update cycles set enrolment_closes_on = current_date + 30 where name = 'Season 25'");

    expect([await milestones(c, manager), await milestones(c, sia)]).toEqual([
      [{ message: 'Season 24 is in week 13, its break and reflection week: get the next season ready to start.', role: 'manager', overdue: false }],
      [],
    ]);
  });
});
