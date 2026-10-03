import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, FRI_4PM_PT, WED_230PM_PT } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan), Fri-B (Kiran commanding),
// one unplaced member with availability (Outsider), and the manager.
async function club() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia], outsider } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
  const [{ id: friB }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [kiran.id]]
  );
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s25.id, kiran.id]);
  await club.as(outsider).query('update profiles set slots = $1 where id = $2', [JSON.stringify([WED_230PM_PT]), outsider.id]);
  return { ...fixture, sia, kiran, friB };
}

async function recipients(fixture) {
  const everyone = [fixture.manager, ...fixture.members, fixture.kiran, fixture.outsider];
  const names = [];
  for (const person of everyone) {
    const got = await fixture.club.as(person).query("select message from my_notices() where kind = 'announcement'");
    if (got.length) names.push((await fixture.club.as(person).query('select full_name from profiles where id = auth.uid()'))[0].full_name);
  }
  return names.sort();
}

async function announce(fixture, author, audience, groups = []) {
  const [{ id }] = await fixture.club.as(author).query(
    "select send_announcement($1, $2, $3::uuid[], 'WAMs pause over the holidays.') as id",
    [fixture.s25.id, audience, groups]
  );
  return id;
}

describe('announcements', () => {
  test('a club manager can announce to everyone', async () => {
    const fixture = await club();

    await announce(fixture, fixture.manager, 'everyone');

    expect(await recipients(fixture)).toEqual(['Jessica', 'Kiran', 'Outsider', 'Shan', 'Sia']);
  });

  test('a club manager can announce to selected groups', async () => {
    const fixture = await club();

    await announce(fixture, fixture.manager, 'groups', [fixture.friB]);

    expect(await recipients(fixture)).toEqual(['Kiran']);
  });

  test('a club manager can announce to all group commanders', async () => {
    const fixture = await club();

    await announce(fixture, fixture.manager, 'commanders');

    expect(await recipients(fixture)).toEqual(['Kiran', 'Sia']);
  });

  test('a club manager can announce to unplaced members', async () => {
    const fixture = await club();

    await announce(fixture, fixture.manager, 'unplaced');

    expect(await recipients(fixture)).toEqual(['Outsider']);
  });

  test('the announcement records its audience and how many it reached', async () => {
    const fixture = await club();
    await announce(fixture, fixture.manager, 'commanders');

    const sent = await fixture.club.as(fixture.manager).query('select audience, recipient_count, body from sent_announcements()');

    expect(sent).toEqual([{ audience: 'All group commanders', recipient_count: 2, body: 'WAMs pause over the holidays.' }]);
  });

  test('a group commander can announce to their own group', async () => {
    const fixture = await club();

    await announce(fixture, fixture.sia, 'groups', [fixture.groupId]);

    expect(await recipients(fixture)).toEqual(['Jessica', 'Shan']);
  });

  test("a group commander cannot announce to another group", async () => {
    const fixture = await club();

    await expect(announce(fixture, fixture.sia, 'groups', [fixture.friB])).rejects.toThrow(/only to your own group/i);
  });

  test('a group commander cannot announce to everyone', async () => {
    const fixture = await club();

    await expect(announce(fixture, fixture.sia, 'everyone')).rejects.toThrow(/only to your own group/i);
  });
});
