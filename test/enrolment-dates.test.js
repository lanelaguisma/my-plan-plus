import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

async function twoSeasons() {
  const c = await freshClub();
  const manager = await c.register({ email: 'manager@example.com', fullName: 'Manager' });
  await c.makeClubManager(manager);
  const sia = await c.register({ email: 'sia@example.com', fullName: 'Sia' });
  const [s24] = await c.owner("insert into cycles (name, start_date, status) values ('Season 24', '2026-10-05', 'active') returning id");
  const [s25] = await c.owner("insert into cycles (name, start_date, status) values ('Season 25', '2027-01-04', 'enrolling') returning id");
  return { club: c, manager, sia, s24: s24.id, s25: s25.id };
}
const dates = async (club, person, season) =>
  (await club.as(person).query('select opens_on::text, closes_on::text from season_enrolment_dates($1)', [season]))[0];

describe('planned enrolment dates', () => {
  test('worked out: opens at week 11 of the season before, closes the day before it starts', async () => {
    const { club, sia, s25 } = await twoSeasons();
    expect(await dates(club, sia, s25)).toEqual({ opens_on: '2026-12-14', closes_on: '2027-01-03' });
  });

  test('the first season has no worked-out opening date', async () => {
    const { club, sia, s24 } = await twoSeasons();
    expect(await dates(club, sia, s24)).toEqual({ opens_on: null, closes_on: '2026-10-04' });
  });

  test("a club manager's dates take precedence, and clearing them restores the worked-out ones", async () => {
    const { club, manager, sia, s25 } = await twoSeasons();
    await club.as(manager).query("select set_season_enrolment_dates($1, '2026-12-01', '2026-12-28')", [s25]);
    const set = await dates(club, sia, s25);
    await club.as(manager).query('select set_season_enrolment_dates($1, null, null)', [s25]);

    expect([set, await dates(club, sia, s25)]).toEqual([
      { opens_on: '2026-12-01', closes_on: '2026-12-28' },
      { opens_on: '2026-12-14', closes_on: '2027-01-03' },
    ]);
  });

  test('only a club manager can set them, and opening must come first', async () => {
    const { club, manager, sia, s25 } = await twoSeasons();
    await expect(club.as(sia).query("select set_season_enrolment_dates($1, '2026-12-01', null)", [s25]))
      .rejects.toThrow(/only a club manager/i);
    await expect(club.as(manager).query("select set_season_enrolment_dates($1, '2026-12-20', '2026-12-10')", [s25]))
      .rejects.toThrow(/open before it closes/i);
  });
});
