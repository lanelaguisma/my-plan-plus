import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, FRI_4PM_PT } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan) in its fourth week; Fri-B
// (Kiran commanding) alongside.
async function runningGroup() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia, jessica, shan] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
  const [{ id: friB }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [kiran.id]]
  );
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s25.id, kiran.id]);
  await club.owner(
    "update cycles set status = 'active', start_date = (date_trunc('week', now()) - interval '21 days')::date where id = $1",
    [s25.id]
  );
  return { ...fixture, sia, jessica, shan, kiran, friB };
}

const checkIn = (club, who, seasonId, week, score) =>
  club.as(who).query('insert into checkins (user_id, cycle_id, week, score) values (auth.uid(), $1, $2, $3)', [seasonId, week, score]);

const dashboard = (club, who, groupId, seasonId) =>
  club.as(who).query('select * from group_roster_dashboard($1, $2)', [groupId, seasonId]);

describe('the group roster dashboard', () => {
  test("shows each member's latest score, average and check-in streak", async () => {
    const { club, s25, groupId, sia, jessica } = await runningGroup();
    for (const [w, sc] of [[1, 60], [2, 80], [3, 90]]) await checkIn(club, jessica, s25.id, w, sc);
    await checkIn(club, sia, s25.id, 1, 50);

    const rows = Object.fromEntries((await dashboard(club, sia, groupId, s25.id))
      .map(r => [r.full_name, [r.latest_week, r.latest_score, r.average_score, r.streak]]));

    expect(rows).toEqual({ Sia: [1, 50, 50, 0], Jessica: [3, 90, 77, 3], Shan: [null, null, null, 0] });
  });

  test('shows attendance over the last three WAMs and the next WAM RSVP', async () => {
    const { club, s25, groupId, sia, jessica } = await runningGroup();
    await club.as(sia).query('select confirm_attendance($1, $2, 3, $3)', [groupId, s25.id, [sia.id, jessica.id]]);
    const [{ week: next }] = await club.owner(
      "select min(week) as week from season_wams($1, $2) where starts_at > now()", [groupId, s25.id]);
    await club.as(jessica).query("select set_rsvp($1, $2, $3, false, 'travelling')", [groupId, s25.id, next]);

    const rows = Object.fromEntries((await dashboard(club, sia, groupId, s25.id))
      .map(r => [r.full_name, [r.attended, r.held, r.next_can_attend, r.next_note]]));

    expect(rows).toEqual({ Sia: [3, 3, true, null], Jessica: [3, 3, false, 'travelling'], Shan: [2, 3, true, null] });
  });

  test('lists pending members and marks the commander first', async () => {
    const { club, s25, groupId, sia } = await runningGroup();
    await club.as(sia).query("select add_pending_member($1, $2, 'Mia', 'mia@example.com')", [groupId, s25.id]);

    expect((await dashboard(club, sia, groupId, s25.id)).map(r => [r.full_name, r.status, r.is_commander])).toEqual([
      ['Sia', 'on_roster', true], ['Jessica', 'on_roster', false], ['Mia', 'pending_registration', false], ['Shan', 'on_roster', false],
    ]);
  });

  test("a club manager can open any group's dashboard; members and other commanders cannot", async () => {
    const { club, manager, s25, groupId, jessica, kiran } = await runningGroup();

    expect((await dashboard(club, manager, groupId, s25.id)).length).toBe(3);
    await expect(dashboard(club, jessica, groupId, s25.id)).rejects.toThrow(/only the group's commander/i);
    await expect(dashboard(club, kiran, groupId, s25.id)).rejects.toThrow(/only the group's commander/i);
  });
});

describe("a member's goals", () => {
  async function withPlan() {
    const fixture = await runningGroup();
    const { club, s25, jessica } = fixture;
    await club.as(jessica).query(
      "insert into plan_data (user_id, key, data) values (auth.uid(), 'myplanplus_goals', $1), (auth.uid(), 'myplanplus_tactics', $2)",
      [JSON.stringify([{ id: 'g1', title: 'Run a half marathon' }]), JSON.stringify([{ id: 't1', goalId: 'g1', title: 'Run 3x a week' }])]
    );
    await checkIn(club, jessica, s25.id, 1, 70);
    return fixture;
  }
  const planOf = (club, who, member, seasonId) =>
    club.as(who).query('select * from member_plan($1, $2)', [member.id, seasonId]);

  test('are visible to their group commander, with their weekly scores', async () => {
    const { club, s25, sia, jessica } = await withPlan();

    expect(await planOf(club, sia, jessica, s25.id)).toEqual([{
      goals: [{ id: 'g1', title: 'Run a half marathon' }],
      tactics: [{ id: 't1', goalId: 'g1', title: 'Run 3x a week' }],
      scores: [{ week: 1, score: 70 }],
    }]);
  });

  test('are visible to a club manager', async () => {
    const { club, manager, s25, jessica } = await withPlan();

    expect((await planOf(club, manager, jessica, s25.id))[0].goals).toEqual([{ id: 'g1', title: 'Run a half marathon' }]);
  });

  test('are hidden from fellow members and from other groups\' commanders', async () => {
    const { club, s25, jessica, shan, kiran } = await withPlan();

    await expect(planOf(club, shan, jessica, s25.id)).rejects.toThrow(/only the member's group commander/i);
    await expect(planOf(club, kiran, jessica, s25.id)).rejects.toThrow(/only the member's group commander/i);
    expect(await club.as(shan).query('select * from plan_data where user_id = $1', [jessica.id])).toEqual([]);
  });
});
