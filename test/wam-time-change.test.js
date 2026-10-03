import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, WED_230PM_PT } from './fixtures.js';

const THU_230PM_PT = WED_230PM_PT + 1440;

// Wed Mavericks running in a season that started three Mondays ago.
async function runningGroup() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner(
    "update cycles set status = 'active', start_date = (date_trunc('week', now()) - interval '21 days')::date where id = $1",
    [s25.id]
  );
  return { ...fixture, sia };
}

async function weekStarts(club, viewer, groupId, seasonId) {
  const rows = await club.as(viewer).query('select week, starts_at from season_wams($1, $2) order by week', [groupId, seasonId]);
  return rows.map(r => new Date(r.starts_at).getTime());
}

describe('changing a group\'s regular WAM time', () => {
  test('an approved proposal moves future WAMs but not past ones', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await runningGroup();
    const before = await weekStarts(club, outsider, groupId, s25.id);
    const [{ id }] = await club.as(sia).query('select propose_wam_time($1, $2) as id', [groupId, THU_230PM_PT]);

    await club.as(manager).query('select decide_wam_time($1, true)', [id]);

    const after = await weekStarts(club, outsider, groupId, s25.id);
    const day = 24 * 3600e3;
    expect([after[0] - before[0], after[2] - before[2], after[5] - before[5], after[11] - before[11]]).toEqual([0, 0, day, day]);
  });

  test('club managers are told about a proposal', async () => {
    const { club, manager, groupId, sia } = await runningGroup();

    await club.as(sia).query('select propose_wam_time($1, $2)', [groupId, THU_230PM_PT]);

    expect(await club.as(manager).query("select action from my_notices() where kind = 'wam_time_proposal'"))
      .toEqual([{ action: 'review_wam_time' }]);
  });

  test('a rejected proposal changes nothing and tells the commander', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await runningGroup();
    const before = await weekStarts(club, outsider, groupId, s25.id);
    const [{ id }] = await club.as(sia).query('select propose_wam_time($1, $2) as id', [groupId, THU_230PM_PT]);

    await club.as(manager).query('select decide_wam_time($1, false)', [id]);

    expect([
      await weekStarts(club, outsider, groupId, s25.id),
      await club.as(sia).query("select message from my_notices() where kind = 'wam_time_decided'"),
    ]).toEqual([before, [{ message: "Your proposal to move Wed Mavericks's WAM time was declined." }]]);
  });

  test('the roster is told the new regular time in their own time zone', async () => {
    const { club, manager, groupId, members: [, jessica] } = await runningGroup();
    await club.as(jessica).query("update profiles set timezone = 'America/Los_Angeles' where id = $1", [jessica.id]);

    await club.as(manager).query('select set_wam_time($1, $2)', [groupId, THU_230PM_PT]);

    const [notice] = await club.as(jessica).query("select message from my_notices() where kind = 'wam_time_changed'");
    expect(notice.message).toMatch(/^Wed Mavericks's WAM time is now Thu (1|2):30 PM\.$/);
  });

  test("a member who isn't the commander cannot propose a new time", async () => {
    const { club, groupId, members: [, jessica] } = await runningGroup();

    await expect(club.as(jessica).query('select propose_wam_time($1, $2)', [groupId, THU_230PM_PT]))
      .rejects.toThrow(/only the group's commander/i);
  });

  test('a group commander cannot approve their own proposal', async () => {
    const { club, groupId, sia } = await runningGroup();
    const [{ id }] = await club.as(sia).query('select propose_wam_time($1, $2) as id', [groupId, THU_230PM_PT]);

    await expect(club.as(sia).query('select decide_wam_time($1, true)', [id])).rejects.toThrow(/only a club manager/i);
  });
});
