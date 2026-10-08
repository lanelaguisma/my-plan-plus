import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

const statuses = async (club, who, seasonId) =>
  Object.fromEntries((await club.as(who).query('select * from club_roster($1)', [seasonId]))
    .map(r => [r.full_name, { status: r.status, group: r.group_name, commander: r.is_commander }]));

describe('the club roster', () => {
  test('shows where everyone stands this season', async () => {
    const { club, manager, s25, groupId, members: [sia, jessica, shan] } = await clubWithWedMavericks({ rosterSize: 3 });
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
    await club.as(sia).query("select record_departure($1, $2, $3, 'stopped attending')", [shan.id, groupId, s25.id]);
    const ready = await club.register({ email: 'ready@example.com', fullName: 'Ready' });
    await club.owner("update profiles set slots = '[1]' where id = $1", [ready.id]);
    await club.as(sia).query("select add_pending_member($1, $2, 'Mia', 'mia@example.com')", [groupId, s25.id]);

    expect(await statuses(club, manager, s25.id)).toEqual({
      Jessica: { status: 'placed', group: 'Wed Mavericks', commander: false },
      Manager: { status: 'not_enrolled', group: null, commander: false },
      Mia: { status: 'pending_registration', group: 'Wed Mavericks', commander: false },
      Outsider: { status: 'not_enrolled', group: null, commander: false },
      Ready: { status: 'unplaced', group: null, commander: false },
      Shan: { status: 'departed', group: 'Wed Mavericks', commander: false },
      Sia: { status: 'placed', group: 'Wed Mavericks', commander: true },
    });
  });

  test('a member moved by a club manager shows in their new group, not as departed', async () => {
    const { club, manager, s25, members: [, jessica] } = await clubWithWedMavericks({ rosterSize: 2 });
    const [{ id: friB }] = await club.as(manager).query("select create_season_group($1, 'Fri-B', 100) as id", [s25.id]);

    await club.as(manager).query('select assign_member($1, $2, $3)', [jessica.id, friB, s25.id]);

    expect((await statuses(club, manager, s25.id)).Jessica).toEqual({ status: 'placed', group: 'Fri-B', commander: false });
  });

  test('newcomers show who invited them', async () => {
    const { club, manager, s25, members: [sia] } = await clubWithWedMavericks();
    const [{ invite_code }] = await club.owner('select invite_code from profiles where id = $1', [sia.id]);
    await club.owner('insert into auth.users (email, raw_user_meta_data) values ($1, $2)',
      ['mia@example.com', { full_name: 'Mia', invite_code }]);

    const [mia] = (await club.as(manager).query('select * from club_roster($1)', [s25.id])).filter(r => r.full_name === 'Mia');
    expect([mia.invited_by_name, mia.status]).toEqual(['Sia', 'not_enrolled']);
  });

  test('awaiting continuation is shown during enrolment', async () => {
    const { club, manager, members: [sia] } = await clubWithWedMavericks();
    const [s26] = await club.owner("insert into cycles (name, start_date) values ('Season 26', '2027-04-05') returning id");
    await club.as(manager).query('select open_enrolment($1)', [s26.id]);

    expect((await statuses(club, manager, s26.id)).Sia).toEqual({ status: 'awaiting_continuation', group: 'Wed Mavericks', commander: false });
  });

  test('only club managers see the club roster', async () => {
    const { club, s25, members: [sia] } = await clubWithWedMavericks();

    await expect(club.as(sia).query('select * from club_roster($1)', [s25.id])).rejects.toThrow(/only a club manager/i);
  });
});
