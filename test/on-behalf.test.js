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

const enterCheckin = (club, who, member, seasonId, week, score, note = null) =>
  club.as(who).query('select enter_checkin_for($1, $2, $3, $4, $5)', [member.id, seasonId, week, score, note]);
const myCheckin = (club, who, seasonId, week) =>
  club.as(who).query('select score, entered_by from checkins where user_id = auth.uid() and cycle_id = $1 and week = $2', [seasonId, week]);
const noticesOf = (club, who) =>
  club.as(who).query("select message from my_notices() where kind = 'entered_for_you'").then(r => r.map(n => n.message));

describe('check-ins entered on behalf', () => {
  test('a group commander logs a member\'s check-in; it is marked and the member is told', async () => {
    const { club, s25, sia, jessica } = await runningGroup();

    await enterCheckin(club, sia, jessica, s25.id, 3, 80, 'given at the WAM');

    expect([await myCheckin(club, jessica, s25.id, 3), await noticesOf(club, jessica)]).toEqual([
      [{ score: 80, entered_by: sia.id }],
      ['Sia logged a 80% check-in for week 3 for you ("given at the WAM"). Record your own check-in any time to replace it.'],
    ]);
  });

  test('it counts in the shared scoreboard', async () => {
    const { club, s25, sia, jessica, kiran } = await runningGroup();

    await enterCheckin(club, sia, jessica, s25.id, 3, 80);

    expect(await club.as(kiran).query('select score from checkin_scores where user_id = $1 and week = 3', [jessica.id]))
      .toEqual([{ score: 80 }]);
  });

  test("the member's own check-in replaces it and clears who entered it", async () => {
    const { club, s25, sia, jessica } = await runningGroup();
    await enterCheckin(club, sia, jessica, s25.id, 3, 80);

    await club.as(jessica).query(
      'update checkins set score = 95 where user_id = auth.uid() and cycle_id = $1 and week = 3', [s25.id]);

    expect(await myCheckin(club, jessica, s25.id, 3)).toEqual([{ score: 95, entered_by: null }]);
  });

  test("a member's own check-in is never overwritten", async () => {
    const { club, s25, sia, jessica } = await runningGroup();
    await club.as(jessica).query('insert into checkins (user_id, cycle_id, week, score) values (auth.uid(), $1, 3, 60)', [s25.id]);

    await expect(enterCheckin(club, sia, jessica, s25.id, 3, 80)).rejects.toThrow(/already checked in for week 3/i);
  });

  test('a club manager can enter for anyone', async () => {
    const { club, manager, s25, kiran } = await runningGroup();

    await enterCheckin(club, manager, kiran, s25.id, 2, 70);

    expect(await myCheckin(club, kiran, s25.id, 2)).toEqual([{ score: 70, entered_by: manager.id }]);
  });

  test('fellow members and other commanders cannot enter for a member', async () => {
    const { club, s25, jessica, shan, kiran } = await runningGroup();

    await expect(enterCheckin(club, shan, jessica, s25.id, 3, 80)).rejects.toThrow(/only the member's group commander/i);
    await expect(enterCheckin(club, kiran, jessica, s25.id, 3, 80)).rejects.toThrow(/only the member's group commander/i);
  });

  test('a commander cannot enter for themselves as if for someone else', async () => {
    const { club, s25, sia } = await runningGroup();

    await expect(enterCheckin(club, sia, sia, s25.id, 3, 80)).rejects.toThrow(/only the member's group commander/i);
  });
});

describe('RSVPs entered on behalf', () => {
  async function nextWeek(club, groupId, seasonId) {
    const [{ week }] = await club.owner('select min(week) as week from season_wams($1, $2) where starts_at > now()', [groupId, seasonId]);
    return week;
  }

  test("a group commander marks a member as can't make it", async () => {
    const { club, s25, groupId, sia, jessica } = await runningGroup();
    const week = await nextWeek(club, groupId, s25.id);

    await club.as(sia).query("select set_rsvp_for($1, $2, $3, $4, false, 'texted me')", [jessica.id, groupId, s25.id, week]);

    expect([
      await club.as(jessica).query('select note, entered_by from rsvps where week = $1', [week]),
      (await club.as(sia).query('select expected_attendance($1, $2, $3) as n', [groupId, s25.id, week]))[0].n,
      await noticesOf(club, jessica),
    ]).toEqual([[{ note: 'texted me', entered_by: sia.id }], 2, [`Sia marked you as unable to make the week ${week} WAM.`]]);
  });

  test("the member's own RSVP clears who entered it", async () => {
    const { club, s25, groupId, sia, jessica } = await runningGroup();
    const week = await nextWeek(club, groupId, s25.id);
    await club.as(sia).query("select set_rsvp_for($1, $2, $3, $4, false, 'texted me')", [jessica.id, groupId, s25.id, week]);

    await club.as(jessica).query("select set_rsvp($1, $2, $3, false, 'away')", [groupId, s25.id, week]);

    expect(await club.as(jessica).query('select note, entered_by from rsvps where week = $1', [week]))
      .toEqual([{ note: 'away', entered_by: null }]);
  });

  test('another group\'s commander cannot RSVP for a member', async () => {
    const { club, s25, groupId, jessica, kiran } = await runningGroup();

    await expect(club.as(kiran).query('select set_rsvp_for($1, $2, $3, 5, false, null)', [jessica.id, groupId, s25.id]))
      .rejects.toThrow(/only the member's group commander/i);
  });
});

describe('preferences entered on behalf', () => {
  test('a group commander updates a member\'s availability and preferences', async () => {
    const { club, sia, jessica } = await runningGroup();

    await club.as(sia).query("select update_preferences_for($1, '[100, 200]', 200, 'Mornings only')", [jessica.id]);

    expect([
      await club.as(jessica).query('select slots, preferred_slot, looking_for, preferences_entered_by from profiles where id = auth.uid()'),
      await noticesOf(club, jessica),
    ]).toEqual([
      [{ slots: [100, 200], preferred_slot: 200, looking_for: 'Mornings only', preferences_entered_by: sia.id }],
      ['Sia updated your availability and preferences. Check them under Your Preferences.'],
    ]);
  });

  test("the member's own update clears who entered them", async () => {
    const { club, sia, jessica } = await runningGroup();
    await club.as(sia).query("select update_preferences_for($1, '[100]', null, '')", [jessica.id]);

    await club.as(jessica).query("update profiles set slots = '[300]' where id = auth.uid()");

    expect((await club.as(jessica).query('select preferences_entered_by from profiles where id = auth.uid()'))[0].preferences_entered_by).toBeNull();
  });

  test('nobody can stamp "entered by" directly', async () => {
    const { club, manager, jessica } = await runningGroup();

    await expect(club.as(manager).query('update profiles set preferences_entered_by = $1 where id = $2', [manager.id, jessica.id]))
      .rejects.toThrow(/update_preferences_for/);
  });

  test('a fellow member cannot update preferences for someone', async () => {
    const { club, jessica, shan } = await runningGroup();

    await expect(club.as(shan).query("select update_preferences_for($1, '[100]', null, '')", [jessica.id]))
      .rejects.toThrow(/only the member's group commander/i);
  });

  test('the preferred time must be one of the available times', async () => {
    const { club, sia, jessica } = await runningGroup();

    await expect(club.as(sia).query("select update_preferences_for($1, '[100]', 200, '')", [jessica.id]))
      .rejects.toThrow(/preferred time must be one of/i);
  });
});
