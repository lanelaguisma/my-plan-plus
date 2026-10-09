import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

const club_ = (club, person) => club.as(person).query(
  "select kind, message, role from my_reminders() where kind like 'club_%' order by kind");

// Season 25 enrolling with Wed Mavericks (Sia commanding, Jessica, Shan)
// full at a capacity of 3: no health flags.
async function healthyClub() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner('update groups set capacity_override = 3 where id = $1', [groupId]);
  return { ...fixture, sia };
}

describe('club needs attention reminder', () => {
  test('a healthy club with nobody waiting needs nothing', async () => {
    const { club, manager } = await healthyClub();

    expect(await club_(club, manager)).toEqual([]);
  });

  test('one reminder per kind of open work, each in Club manager mode', async () => {
    const { club, manager, s25, groupId, sia, members: [, jessica], outsider } = await healthyClub();
    await club.owner("update profiles set slots = '[100]' where id = $1", [outsider.id]);
    await club.as(jessica).query("select request_transfer($1, 'Fridays suit me better')", [s25.id]);
    await club.owner('update groups set capacity_override = 4 where id = $1', [groupId]);
    await club.as(sia).query("select add_pending_member($1, $2, 'Mia', 'mia@example.com')", [groupId, s25.id]);
    await club.as(manager).query('select appoint_group_commander($1, $2, null)', [groupId, s25.id]);

    expect(await club_(club, manager)).toEqual([
      { kind: 'club_at_risk', message: '1 group is at risk in Season 25: Wed Mavericks.', role: 'manager' },
      { kind: 'club_pending', message: '1 pending member for Season 25 is still to register.', role: 'manager' },
      { kind: 'club_transfers', message: '1 open transfer request for Season 25.', role: 'manager' },
      { kind: 'club_unplaced', message: '1 unplaced member for Season 25 — place them in a group.', role: 'manager' },
    ]);
  });

  test('it clears when the work is done, and only club managers see it', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await healthyClub();
    await club.owner("update profiles set slots = '[100]' where id = $1", [outsider.id]);
    const forCommander = await club_(club, sia);

    await club.owner('update groups set capacity_override = 4 where id = $1', [groupId]);
    await club.as(manager).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);

    expect([forCommander, await club_(club, manager)]).toEqual([[], []]);
  });
});
