import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan, Kiran) in its fourth week.
async function inWeekFour() {
  const fixture = await clubWithWedMavericks({ rosterSize: 4 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner(
    "update cycles set status = 'active', start_date = (date_trunc('week', now()) - interval '21 days')::date where id = $1",
    [s25.id]
  );
  const [sia_, jessica, shan, kiran] = fixture.members;
  return { ...fixture, sia, jessica, shan, kiran };
}

async function pulse(club, member, seasonId, rating, { week = 4, comment = null, help = false } = {}) {
  await club.as(member).query('select submit_pulse($1, $2, $3, $4, $5)', [seasonId, week, rating, comment, help]);
}

describe('the pulse', () => {
  test("a club manager sees each member's pulse and comment", async () => {
    const { club, manager, s25, jessica } = await inWeekFour();

    await pulse(club, jessica, s25.id, 'not_working', { comment: 'The time no longer suits me', help: true });

    expect(await club.as(manager).query('select member_name, week, rating, comment, wants_help from season_pulses($1)', [s25.id]))
      .toEqual([{ member_name: 'Jessica', week: 4, rating: 'not_working', comment: 'The time no longer suits me', wants_help: true }]);
  });

  test("a group commander cannot read anyone's individual pulse", async () => {
    const { club, s25, sia, jessica } = await inWeekFour();
    await pulse(club, jessica, s25.id, 'not_working');

    const direct = await club.as(sia).query('select rating from pulses where member_id <> auth.uid()');

    await expect(club.as(sia).query('select * from season_pulses($1)', [s25.id])).rejects.toThrow(/only a club manager/i);
    expect(direct).toEqual([]);
  });

  test("a group commander sees their group's combined pulse once three have answered", async () => {
    const { club, s25, groupId, sia, jessica, shan, kiran } = await inWeekFour();
    await pulse(club, jessica, s25.id, 'working');
    await pulse(club, shan, s25.id, 'working');
    await pulse(club, kiran, s25.id, 'so_so', { help: true });

    expect(await club.as(sia).query('select responses, working, so_so, not_working, wants_help from group_pulse($1, $2, 4)', [groupId, s25.id]))
      .toEqual([{ responses: 3, working: 2, so_so: 1, not_working: 0, wants_help: 1 }]);
  });

  test('the combined pulse is hidden until three have answered', async () => {
    const { club, s25, groupId, sia, jessica, shan } = await inWeekFour();
    await pulse(club, jessica, s25.id, 'working');
    await pulse(club, shan, s25.id, 'not_working');

    expect(await club.as(sia).query('select responses, working, so_so, not_working, wants_help from group_pulse($1, $2, 4)', [groupId, s25.id]))
      .toEqual([{ responses: 2, working: null, so_so: null, not_working: null, wants_help: null }]);
  });

  test('answering again replaces the earlier answer', async () => {
    const { club, manager, s25, jessica } = await inWeekFour();
    await pulse(club, jessica, s25.id, 'so_so');

    await pulse(club, jessica, s25.id, 'working');

    expect(await club.as(manager).query('select rating from season_pulses($1)', [s25.id])).toEqual([{ rating: 'working' }]);
  });

  test('pulses are only taken in weeks 4, 8 and 13', async () => {
    const { club, s25, jessica } = await inWeekFour();

    await expect(pulse(club, jessica, s25.id, 'working', { week: 5 })).rejects.toThrow(/weeks 4, 8 and 13/i);
  });

  test('someone not on a roster cannot answer the pulse', async () => {
    const { club, s25, outsider } = await inWeekFour();

    await expect(pulse(club, outsider, s25.id, 'working')).rejects.toThrow(/not on a roster/i);
  });

  test('members are reminded in a pulse week until they answer', async () => {
    const { club, s25, jessica } = await inWeekFour();

    const before = await club.as(jessica).query("select message, action, role from my_reminders() where kind = 'pulse'");
    const notices = await club.as(jessica).query("select key from my_notices() where kind = 'pulse'");
    await pulse(club, jessica, s25.id, 'working');
    const after = await club.as(jessica).query("select message from my_reminders() where kind = 'pulse'");

    expect([before, notices, after]).toEqual([
      [{ message: 'How is Wed Mavericks working for you? Week 4 pulse — it takes one tap.', action: 'answer_pulse', role: 'member' }],
      [],
      [],
    ]);
  });
});
