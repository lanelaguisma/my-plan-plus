import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan) in its third week or so,
// with a WAM 12 hours from now and everyone's check-ins up to date.
async function wamTomorrow() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia, jessica, shan] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner(
    `update groups set slot_mow = (extract(epoch from (now() + interval '12 hours')
       - (date_trunc('week', now() at time zone 'UTC') at time zone 'UTC')) / 60)::int % 10080 where id = $1`, [groupId]);
  await club.owner(
    `update cycles set status = 'active', start_date = (date_trunc('week', now() + interval '12 hours') - interval '14 days')::date
      where id = $1`, [s25.id]);
  const [{ week }] = await club.as(sia).query(
    "select week from season_wams($1, $2) where starts_at > now() and starts_at <= now() + interval '24 hours'", [groupId, s25.id]);
  for (const m of [sia, jessica, shan]) {
    await club.owner('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, $3, 80)', [m.id, s25.id, week - 1]);
  }
  return { ...fixture, sia, jessica, shan, week };
}
const prep = (club, person) => club.as(person).query("select message, role, action from my_reminders() where kind = 'wam_prep'");

describe('commander WAM prep reminder', () => {
  test('nothing to prepare when everyone is coming and up to date', async () => {
    const { club, sia } = await wamTomorrow();

    expect(await prep(club, sia)).toEqual([]);
  });

  test("lists who can't make it and who still owes last week's check-in", async () => {
    const { club, s25, groupId, sia, jessica, shan, week } = await wamTomorrow();
    await club.as(jessica).query("select set_rsvp($1, $2, $3, false, 'Travelling')", [groupId, s25.id, week]);
    await club.owner('delete from checkins where user_id = $1', [shan.id]);

    expect(await prep(club, sia)).toEqual([{
      message: `Wed Mavericks week ${week} WAM prep: Jessica can't make it; Shan still owes the week ${week - 1} check-in.`,
      role: 'commander', action: 'view_roster',
    }]);
  });

  test('only the commander sees it, and a logged check-in clears it', async () => {
    const { club, s25, sia, shan, week } = await wamTomorrow();
    await club.owner('delete from checkins where user_id = $1', [shan.id]);
    const others = await prep(club, shan);

    await club.as(sia).query('select enter_checkin_for($1, $2, $3, 60, null)', [shan.id, s25.id, week - 1]);

    expect([others, await prep(club, sia)]).toEqual([[], []]);
  });

  test('a cancelled WAM needs no prep', async () => {
    const { club, s25, groupId, sia, shan, week } = await wamTomorrow();
    await club.owner('delete from checkins where user_id = $1', [shan.id]);

    await club.as(sia).query('select cancel_wam($1, $2, $3)', [groupId, s25.id, week]);

    expect(await prep(club, sia)).toEqual([]);
  });
});
