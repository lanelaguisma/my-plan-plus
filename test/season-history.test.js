import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

// Wed Mavericks across two seasons: Season 24 (archived; Sia commanding,
// Jessica, Shan) and Season 25 (running; Jessica commanding, Sia, Kiran).
// Sia checked in 80 and 60 in S24; one S24 WAM had Shan away.
async function twoSeasons() {
  const club = await freshClub();
  const manager = await club.register({ email: 'manager@example.com', fullName: 'Manager' });
  await club.makeClubManager(manager);
  const p = {};
  for (const n of ['Sia', 'Jessica', 'Shan', 'Kiran']) p[n.toLowerCase()] = await club.register({ email: `${n.toLowerCase()}@example.com`, fullName: n });
  const [s24] = await club.owner("insert into cycles (name, start_date, status) values ('Season 24', current_date - 140, 'archived') returning id");
  const [s25] = await club.owner("insert into cycles (name, start_date, status) values ('Season 25', current_date - 49, 'active') returning id");
  const [{ id: g }] = await club.as(manager).query(
    "select create_season_group($1, 'Wed Mavericks', 5, $2::uuid[]) as id", [s24.id, [p.sia.id, p.jessica.id, p.shan.id]]);
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [g, s24.id, p.sia.id]);
  await club.owner('insert into group_seasons (group_id, cycle_id) values ($1, $2)', [g, s25.id]);
  for (const m of [p.sia, p.jessica, p.kiran]) {
    await club.owner("insert into group_members (group_id, user_id, cycle_id, status) values ($1, $2, $3, 'on_roster')", [g, m.id, s25.id]);
  }
  await club.owner('update group_seasons set commander_id = $1 where group_id = $2 and cycle_id = $3', [p.jessica.id, g, s25.id]);
  await club.owner('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 1, 80), ($1, $2, 2, 60)', [p.sia.id, s24.id]);
  await club.owner('insert into rsvps (group_id, cycle_id, week, member_id) values ($1, $2, 1, $3)', [g, s24.id, p.shan.id]);
  await club.owner("insert into pulses (member_id, cycle_id, week, group_id, rating) values ($1, $2, 4, $3, 'working'), ($4, $2, 4, $3, 'so_so')",
    [p.sia.id, s24.id, g, p.jessica.id]);
  return { club, manager, g, s24: s24.id, s25: s25.id, ...p };
}

describe('season history', () => {
  test("a member sees their own seasons, newest first", async () => {
    const { club, sia } = await twoSeasons();

    const rows = await club.as(sia).query(
      'select season_name, group_name, commander_name, average_checkin, checkins_submitted, attendance_pct from my_season_history()');

    expect(rows).toEqual([
      { season_name: 'Season 25', group_name: 'Wed Mavericks', commander_name: 'Jessica', average_checkin: null, checkins_submitted: 0, attendance_pct: 100 },
      { season_name: 'Season 24', group_name: 'Wed Mavericks', commander_name: 'Sia', average_checkin: 70, checkins_submitted: 2, attendance_pct: 100 },
    ]);
  });

  test("the group's commander sees its seasons as totals, including who carried over", async () => {
    const { club, g, jessica } = await twoSeasons();

    const rows = await club.as(jessica).query(
      'select season_name, commander_name, roster_size, retained, attendance_pct, average_checkin from group_season_history($1)', [g]);

    expect(rows).toEqual([
      { season_name: 'Season 25', commander_name: 'Jessica', roster_size: 3, retained: 2, attendance_pct: 100, average_checkin: null },
      { season_name: 'Season 24', commander_name: 'Sia', roster_size: 3, retained: 0, attendance_pct: 97, average_checkin: 70 },
    ]);
  });

  test("ordinary members, and commanders of earlier seasons only, can't see a group's history", async () => {
    const { club, g, kiran, shan } = await twoSeasons();

    await expect(club.as(kiran).query('select * from group_season_history($1)', [g])).rejects.toThrow(/commander or a club manager/i);
    await expect(club.as(shan).query('select * from group_season_history($1)', [g])).rejects.toThrow(/commander or a club manager/i);
  });

  test('club managers see every group by season, with the average pulse', async () => {
    const { club, manager, sia } = await twoSeasons();

    const rows = await club.as(manager).query(
      'select group_name, season_name, state, roster_size, average_pulse::text from club_season_history()');

    expect(rows).toEqual([
      { group_name: 'Wed Mavericks', season_name: 'Season 24', state: 'active', roster_size: 3, average_pulse: '2.5' },
      { group_name: 'Wed Mavericks', season_name: 'Season 25', state: 'active', roster_size: 3, average_pulse: null },
    ]);
    await expect(club.as(sia).query('select * from club_season_history()')).rejects.toThrow(/only a club manager/i);
  });
});
