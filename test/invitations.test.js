import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup, FRI_4PM_PT } from './fixtures.js';

// Wed Mavericks: 3 of 4 places taken, Sia commanding.
async function commandedGroup({ rosterSize = 3 } = {}) {
  const fixture = await clubWithWedMavericks({ rosterSize });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  return { ...fixture, sia };
}

async function invite(club, commander, groupId, seasonId, member) {
  const [{ id }] = await club.as(commander).query(
    'select send_invitation($1, $2, $3) as id', [groupId, seasonId, member.id]
  );
  return id;
}

async function myOffers(club, member) {
  return club.as(member).query('select * from my_offers() order by sent_at');
}

describe('invitations', () => {
  test('an accepted invitation puts the member on the roster', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);

    await club.as(outsider).query('select respond_to_offer($1, true)', [offer]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(4);
  });

  test('a member reviews the group they are invited to', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await commandedGroup();
    await club.as(manager).query("update groups set emoji = '🐹', purpose = 'Founders' where id = $1", [groupId]);
    await club.as(outsider).query("update profiles set timezone = 'America/Los_Angeles' where id = $1", [outsider.id]);
    await invite(club, sia, groupId, s25.id, outsider);

    const [offer] = await myOffers(club, outsider);

    expect({
      kind: offer.kind, status: offer.status, group: offer.group_name, emoji: offer.emoji,
      purpose: offer.purpose, time: offer.wam_time, commander: offer.commander_name,
      open: offer.vacancies, season: offer.season_name,
    }).toEqual({
      kind: 'invitation', status: 'pending', group: 'Wed Mavericks', emoji: '🐹',
      purpose: 'Founders', time: 'Wed 1:30 PM', commander: 'Sia', open: 1, season: 'Season 25',
    });
  });

  test('accepting one offer withdraws the member\'s other pending offers', async () => {
    const fixture = await commandedGroup();
    const { club, manager, s25, groupId, sia, outsider } = fixture;
    const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
    const [{ id: friB }] = await club.as(manager).query(
      "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [kiran.id]]
    );
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s25.id, kiran.id]);
    const wed = await invite(club, sia, groupId, s25.id, outsider);
    await invite(club, kiran, friB, s25.id, outsider);

    await club.as(outsider).query('select respond_to_offer($1, true)', [wed]);

    expect((await myOffers(club, outsider)).map(o => [o.group_name, o.status])).toEqual([
      ['Wed Mavericks', 'accepted'], ['Fri-B', 'withdrawn'],
    ]);
  });

  test('a declined invitation leaves the member unplaced', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);

    await club.as(outsider).query('select respond_to_offer($1, false)', [offer]);

    expect([(await myOffers(club, outsider))[0].status, (await seasonGroup(club, outsider, groupId, s25.id)).member_count])
      .toEqual(['declined', 3]);
  });

  test('a commander cannot invite beyond capacity', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup({ rosterSize: 4 });

    await expect(invite(club, sia, groupId, s25.id, outsider)).rejects.toThrow(/no open places/i);
  });

  test('an already-placed member cannot be invited', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await commandedGroup();
    const [{ id: friB }] = await club.as(manager).query(
      "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [outsider.id]]
    );

    await expect(invite(club, sia, groupId, s25.id, outsider)).rejects.toThrow(/already on a roster/i);
  });

  test("only the group's commander can invite", async () => {
    const { club, s25, groupId, members: [, jessica], outsider } = await commandedGroup();

    await expect(invite(club, jessica, groupId, s25.id, outsider)).rejects.toThrow(/only the group's commander/i);
  });
});

describe('invitation lifecycle', () => {
  test('an invitation expires 7 days after it was sent', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);
    await club.owner("update placement_offers set sent_at = now() - interval '8 days' where id = $1", [offer]);

    expect((await myOffers(club, outsider))[0].status).toBe('expired');
  });

  test('an invitation sent during enrolment expires when the season starts', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await commandedGroup();
    await invite(club, sia, groupId, s25.id, outsider);

    await club.as(manager).query("update cycles set status = 'active' where id = $1", [s25.id]);

    expect((await myOffers(club, outsider))[0].status).toBe('expired');
  });

  test('an expired invitation cannot be accepted', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);
    await club.owner("update placement_offers set sent_at = now() - interval '8 days' where id = $1", [offer]);

    await expect(club.as(outsider).query('select respond_to_offer($1, true)', [offer]))
      .rejects.toThrow(/no longer open \(expired\)/i);
  });

  test('a withdrawn invitation cannot be accepted', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);
    await club.as(sia).query('select withdraw_offer($1)', [offer]);

    await expect(club.as(outsider).query('select respond_to_offer($1, true)', [offer]))
      .rejects.toThrow(/no longer open \(withdrawn\)/i);
  });

  test('resending an expired invitation makes it pending again', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);
    await club.owner("update placement_offers set sent_at = now() - interval '8 days' where id = $1", [offer]);

    await invite(club, sia, groupId, s25.id, outsider);

    const statuses = (await club.as(sia).query('select status from group_offers($1, $2)', [groupId, s25.id])).map(o => o.status);
    expect(statuses.sort()).toEqual(['expired', 'pending']);
  });

  test('the member is told about the invitation and the commander about the answer', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const offer = await invite(club, sia, groupId, s25.id, outsider);
    await club.as(outsider).query('select respond_to_offer($1, false)', [offer]);

    const toMember = await club.as(outsider).query("select message, action from my_notices() where kind = 'invitation'");
    const toCommander = await club.as(sia).query("select message from my_notices() where kind = 'invitation_answered'");
    expect([toMember, toCommander]).toEqual([
      [{ message: 'Sia invited you to join Wed Mavericks for Season 25.', action: 'review_offers' }],
      [{ message: 'Outsider declined your invitation to Wed Mavericks.' }],
    ]);
  });

  test("a commander lists their group's invitations by status", async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });
    const declined = await invite(club, sia, groupId, s25.id, mia);
    await club.as(mia).query('select respond_to_offer($1, false)', [declined]);
    await invite(club, sia, groupId, s25.id, outsider);

    const offers = await club.as(sia).query(
      'select member_name, status from group_offers($1, $2) order by member_name', [groupId, s25.id]
    );

    expect(offers).toEqual([
      { member_name: 'Mia', status: 'declined' },
      { member_name: 'Outsider', status: 'pending' },
    ]);
  });

  test("a member cannot see another group's offers", async () => {
    const { club, s25, groupId, members: [, jessica] } = await commandedGroup();

    await expect(club.as(jessica).query('select * from group_offers($1, $2)', [groupId, s25.id]))
      .rejects.toThrow(/only the group's commander/i);
  });
});

describe('offer history', () => {
  test('accepting an offer leaves an already-expired offer marked expired', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await commandedGroup();
    const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
    const [{ id: friB }] = await club.as(manager).query(
      "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [kiran.id]]
    );
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s25.id, kiran.id]);
    const old = await invite(club, kiran, friB, s25.id, outsider);
    await club.owner("update placement_offers set sent_at = now() - interval '8 days' where id = $1", [old]);
    const wed = await invite(club, sia, groupId, s25.id, outsider);

    await club.as(outsider).query('select respond_to_offer($1, true)', [wed]);

    expect((await myOffers(club, outsider)).map(o => [o.group_name, o.status])).toEqual([
      ['Fri-B', 'expired'], ['Wed Mavericks', 'accepted'],
    ]);
  });
});
