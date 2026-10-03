import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan) in a season that started
// three Mondays ago: weeks 1-3 are past, week 6 is in the future.
async function runningGroup() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia, jessica, shan] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner(
    "update cycles set status = 'active', start_date = (date_trunc('week', now()) - interval '21 days')::date where id = $1",
    [s25.id]
  );
  const g = [groupId, s25.id];
  return { ...fixture, sia, jessica, shan, g };
}

async function expected(club, viewer, [groupId, seasonId], week) {
  const [{ n }] = await club.as(viewer).query(
    'select expected_attendance($1, $2, $3) as n', [groupId, seasonId, week]
  );
  return n;
}

async function attended(club, viewer, [groupId, seasonId], week) {
  const rows = await club.as(viewer).query(
    `select p.full_name from wam_attendance($1, $2) a join profiles p on p.id = a.member_id
     where a.week = $3 and a.attended order by p.full_name`, [groupId, seasonId, week]
  );
  return rows.map(r => r.full_name);
}

describe('RSVPs', () => {
  test('everyone on the roster is presumed attending', async () => {
    const { club, sia, g } = await runningGroup();

    expect(await expected(club, sia, g, 6)).toBe(3);
  });

  test("a member who can't make it lowers the expected attendance, and can change their mind", async () => {
    const { club, sia, jessica, g } = await runningGroup();

    await club.as(jessica).query("select set_rsvp($1, $2, 6, false, 'Travelling')", g);
    const whileAway = await expected(club, sia, g, 6);
    await club.as(jessica).query('select set_rsvp($1, $2, 6, true, null)', g);

    expect([whileAway, await expected(club, sia, g, 6)]).toEqual([2, 3]);
  });

  test('someone not on the roster cannot RSVP', async () => {
    const { club, outsider, g } = await runningGroup();

    await expect(club.as(outsider).query('select set_rsvp($1, $2, 6, false, null)', g))
      .rejects.toThrow(/not on this group's roster/i);
  });
});

describe('attendance', () => {
  test("a group commander's confirmation records who attended", async () => {
    const { club, sia, jessica, g } = await runningGroup();

    await club.as(sia).query('select confirm_attendance($1, $2, 1, $3::uuid[])', [...g, [sia.id, jessica.id]]);

    expect(await attended(club, sia, g, 1)).toEqual(['Jessica', 'Sia']);
  });

  test("an unconfirmed past WAM falls back to the RSVPs", async () => {
    const { club, sia, shan, g } = await runningGroup();

    await club.as(shan).query('select set_rsvp($1, $2, 2, false, null)', g);

    expect(await attended(club, sia, g, 2)).toEqual(['Jessica', 'Sia']);
  });

  test("a member who isn't the commander cannot confirm attendance", async () => {
    const { club, jessica, g } = await runningGroup();

    await expect(club.as(jessica).query('select confirm_attendance($1, $2, 1, $3::uuid[])', [...g, [jessica.id]]))
      .rejects.toThrow(/only the group's commander/i);
  });

  test('a member sees their own attendance history', async () => {
    const { club, sia, jessica, g } = await runningGroup();
    await club.as(sia).query('select confirm_attendance($1, $2, 1, $3::uuid[])', [...g, [sia.id]]);

    const history = await club.as(jessica).query('select week, attended from my_attendance() where week <= 2 order by week');

    expect(history).toEqual([{ week: 1, attended: false }, { week: 2, attended: true }]);
  });
});

describe('missed WAMs', () => {
  test('the group commander is told when a member misses two WAMs in a row', async () => {
    const { club, sia, jessica, g } = await runningGroup();
    await club.as(sia).query('select confirm_attendance($1, $2, 1, $3::uuid[])', [...g, [sia.id]]);

    await club.as(sia).query('select confirm_attendance($1, $2, 2, $3::uuid[])', [...g, [sia.id]]);

    const notices = await club.as(sia).query("select message from my_notices() where kind = 'missed_wams' order by message");
    expect(notices).toEqual([
      { message: 'Jessica has missed 2 Wed Mavericks WAMs in a row.' },
      { message: 'Shan has missed 2 Wed Mavericks WAMs in a row.' },
    ]);
  });

  test('a cancelled WAM neither counts as a miss nor breaks a run of misses', async () => {
    const { club, sia, g } = await runningGroup();
    await club.as(sia).query('select confirm_attendance($1, $2, 1, $3::uuid[])', [...g, [sia.id]]);
    await club.as(sia).query('select cancel_wam($1, $2, 2)', g);

    await club.as(sia).query('select confirm_attendance($1, $2, 3, $3::uuid[])', [...g, [sia.id]]);

    expect(await club.as(sia).query("select message from my_notices() where kind = 'missed_wams'")).toHaveLength(2);
  });

  test('attendance on a cancelled WAM cannot be confirmed', async () => {
    const { club, sia, g } = await runningGroup();
    await club.as(sia).query('select cancel_wam($1, $2, 2)', g);

    await expect(club.as(sia).query('select confirm_attendance($1, $2, 2, $3::uuid[])', [...g, [sia.id]]))
      .rejects.toThrow(/cancelled/i);
  });
});
