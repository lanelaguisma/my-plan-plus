import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

async function clubWithManager() {
  const club = await freshClub();
  const manager = await club.register({ email: 'manager@example.com', fullName: 'Iain' });
  await club.makeClubManager(manager);
  return { club, manager };
}

async function createSeason(club, manager, name, startDate) {
  const [season] = await club.as(manager).query(
    'insert into cycles (name, start_date) values ($1, $2) returning id',
    [name, startDate]
  );
  return season;
}

describe('season dates', () => {
  test('the suggested start is the Monday after the latest season ends', async () => {
    const { club, manager } = await clubWithManager();
    await createSeason(club, manager, 'Season 24', '2026-10-05');

    const [{ suggested }] = await club.as(manager).query(
      "select to_char(suggested_season_start(), 'YYYY-MM-DD') as suggested"
    );

    expect(suggested).toBe('2027-01-04');
  });

  test("an enrolling season's start date can still move", async () => {
    const { club, manager } = await clubWithManager();
    const s25 = await createSeason(club, manager, 'Season 25', '2027-01-04');
    await club.as(manager).query("update cycles set status = 'enrolling' where id = $1", [s25.id]);

    await club.as(manager).query("update cycles set start_date = '2027-01-11' where id = $1", [s25.id]);

    const [{ start }] = await club.as(manager).query(
      "select to_char(start_date, 'YYYY-MM-DD') as start from cycles where id = $1", [s25.id]
    );
    expect(start).toBe('2027-01-11');
  });

  test("an active season's start date is locked", async () => {
    const { club, manager } = await clubWithManager();
    const s24 = await createSeason(club, manager, 'Season 24', '2026-10-05');
    await club.as(manager).query("update cycles set status = 'active' where id = $1", [s24.id]);

    const moving = club.as(manager).query(
      "update cycles set start_date = '2026-10-12' where id = $1", [s24.id]
    );

    await expect(moving).rejects.toThrow(/start date is locked/i);
  });
});

describe('season weeks', () => {
  async function weekStart(club, manager, seasonId, week) {
    const [{ start }] = await club.as(manager).query(
      "select to_char(season_week_start($1, $2), 'YYYY-MM-DD') as start", [seasonId, week]
    );
    return start;
  }

  test('week 13, the break week, starts twelve weeks after the season', async () => {
    const { club, manager } = await clubWithManager();
    const s24 = await createSeason(club, manager, 'Season 24', '2026-10-05');

    expect(await weekStart(club, manager, s24.id, 13)).toBe('2026-12-28');
  });

  test('week dates follow a start date change before the season starts', async () => {
    const { club, manager } = await clubWithManager();
    const s25 = await createSeason(club, manager, 'Season 25', '2027-01-04');
    await club.as(manager).query("update cycles set start_date = '2027-01-11' where id = $1", [s25.id]);

    expect(await weekStart(club, manager, s25.id, 2)).toBe('2027-01-18');
  });

  test('weeks outside 1 to 13 are rejected', async () => {
    const { club, manager } = await clubWithManager();
    const s24 = await createSeason(club, manager, 'Season 24', '2026-10-05');

    await expect(weekStart(club, manager, s24.id, 14)).rejects.toThrow(/week must be between 1 and 13/i);
  });
});

describe('season date warnings', () => {
  async function warningsFor(club, manager, start) {
    return club.as(manager).query(
      'select kind, other_season from season_date_warnings($1) order by kind', [start]
    );
  }

  test('a start inside the previous season warns of an overlap', async () => {
    const { club, manager } = await clubWithManager();
    await createSeason(club, manager, 'Season 24', '2026-10-05');

    expect(await warningsFor(club, manager, '2026-12-28')).toEqual([
      { kind: 'overlap', other_season: 'Season 24' },
    ]);
  });

  test('a start weeks after the previous season ends warns of a gap', async () => {
    const { club, manager } = await clubWithManager();
    await createSeason(club, manager, 'Season 24', '2026-10-05');

    expect(await warningsFor(club, manager, '2027-01-18')).toEqual([
      { kind: 'gap', other_season: 'Season 24' },
    ]);
  });

  test('the suggested start raises no warnings', async () => {
    const { club, manager } = await clubWithManager();
    await createSeason(club, manager, 'Season 24', '2026-10-05');

    expect(await warningsFor(club, manager, '2027-01-04')).toEqual([]);
  });

  test("a season being edited is not compared with itself", async () => {
    const { club, manager } = await clubWithManager();
    const s24 = await createSeason(club, manager, 'Season 24', '2026-10-05');

    const rows = await club.as(manager).query(
      'select kind from season_date_warnings($1, $2)', ['2026-10-12', s24.id]
    );

    expect(rows).toEqual([]);
  });
});
