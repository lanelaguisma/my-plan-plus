import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica) with two open places.
async function wedMavericks() {
  const fixture = await clubWithWedMavericks({ rosterSize: 2 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  return { ...fixture, sia, jessica: fixture.members[1] };
}

const addPending = (club, who, groupId, seasonId, name, email) =>
  club.as(who).query('select add_pending_member($1, $2, $3, $4) as id', [groupId, seasonId, name, email]).then(r => r[0].id);

describe('pending members', () => {
  test('a pending member holds a place on the roster', async () => {
    const { club, s25, groupId, sia, outsider } = await wedMavericks();

    await addPending(club, sia, groupId, s25.id, 'Mia', 'Mia@Example.com');

    const g = await seasonGroup(club, outsider, groupId, s25.id);
    expect({ member_count: g.member_count, pending_count: g.pending_count, vacancies: g.vacancies, state: g.state })
      .toEqual({ member_count: 3, pending_count: 1, vacancies: 1, state: 'active' });
  });

  test('registering with that email (any case) puts them on the roster and tells the commander', async () => {
    const { club, s25, groupId, sia, outsider } = await wedMavericks();
    await addPending(club, sia, groupId, s25.id, 'Mia', 'mia@example.com');

    const mia = await club.register({ email: 'MIA@example.com', fullName: 'Mia Chen' });

    expect([
      (await seasonGroup(club, outsider, groupId, s25.id)).pending_count,
      (await seasonGroup(club, outsider, groupId, s25.id)).member_count,
      (await club.as(mia).query('select group_id from group_members where user_id = auth.uid()')).map(r => r.group_id),
      (await club.as(sia).query("select message from my_notices() where kind = 'pending_registered'")).map(r => r.message),
    ]).toEqual([0, 3, [groupId], ['Mia Chen registered and is now on the Wed Mavericks roster.']]);
  });

  test('the club manager who added someone is told when they register', async () => {
    const { club, manager, s25, groupId } = await wedMavericks();
    await addPending(club, manager, groupId, s25.id, 'Mia', 'mia@example.com');

    await club.register({ email: 'mia@example.com', fullName: 'Mia' });

    expect((await club.as(manager).query("select count(*)::int as n from my_notices() where kind = 'pending_registered'"))[0].n).toBe(1);
  });

  test('cancelling a pending member frees the place, and their later sign-up places them nowhere', async () => {
    const { club, s25, groupId, sia, outsider } = await wedMavericks();
    const id = await addPending(club, sia, groupId, s25.id, 'Mia', 'mia@example.com');

    await club.as(sia).query('select cancel_pending_member($1)', [id]);
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });

    expect([
      (await seasonGroup(club, outsider, groupId, s25.id)).vacancies,
      (await club.as(mia).query('select count(*)::int as n from group_members where user_id = auth.uid()'))[0].n,
    ]).toEqual([2, 0]);
  });

  test('a group commander cannot hold more places than the group has', async () => {
    const { club, s25, groupId, sia } = await wedMavericks();
    await addPending(club, sia, groupId, s25.id, 'Mia', 'mia@example.com');
    await addPending(club, sia, groupId, s25.id, 'Noor', 'noor@example.com');

    await expect(addPending(club, sia, groupId, s25.id, 'Omar', 'omar@example.com')).rejects.toThrow(/no open places/i);
  });

  test('the same email cannot be pending twice in a season', async () => {
    const { club, manager, s25, groupId, sia } = await wedMavericks();
    await addPending(club, sia, groupId, s25.id, 'Mia', 'mia@example.com');

    await expect(addPending(club, manager, groupId, s25.id, 'Mia C', ' MIA@example.com '))
      .rejects.toThrow(/already pending/i);
  });

  test('someone already registered is invited instead', async () => {
    const { club, s25, groupId, sia } = await wedMavericks();

    await expect(addPending(club, sia, groupId, s25.id, 'Outsider', 'outsider@example.com'))
      .rejects.toThrow(/already registered/i);
  });

  test('only the group commander or a club manager adds or cancels pending members', async () => {
    const { club, s25, groupId, sia, jessica } = await wedMavericks();
    const id = await addPending(club, sia, groupId, s25.id, 'Mia', 'mia@example.com');

    await expect(addPending(club, jessica, groupId, s25.id, 'Noor', 'noor@example.com')).rejects.toThrow(/only the group's commander/i);
    await expect(club.as(jessica).query('select cancel_pending_member($1)', [id])).rejects.toThrow(/only the group's commander/i);
  });

  test("pending members' emails are hidden from the rest of the club", async () => {
    const { club, manager, s25, groupId, sia, jessica, outsider } = await wedMavericks();
    await addPending(club, sia, groupId, s25.id, 'Mia', 'mia@example.com');

    const seen = async who => (await club.as(who).query('select email from pending_members')).map(r => r.email);
    expect([await seen(sia), await seen(manager), await seen(jessica), await seen(outsider)])
      .toEqual([['mia@example.com'], ['mia@example.com'], [], []]);
    await expect(club.as(jessica).query('select * from group_pending_members($1, $2)', [groupId, s25.id]))
      .rejects.toThrow(/only the group's commander/i);
  });
});
