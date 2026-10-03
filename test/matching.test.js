import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, WED_230PM_PT, FRI_4PM_PT } from './fixtures.js';

const LA = 'America/Los_Angeles';

async function setPreferences(club, person, { slots, preferred = null, timezone = LA, lookingFor = '' }) {
  await club.as(person).query(
    'update profiles set slots = $1, preferred_slot = $2, timezone = $3, looking_for = $4 where id = $5',
    [JSON.stringify(slots), preferred, timezone, lookingFor, person.id]
  );
}

// Wed Mavericks (3 of 4, Sia commanding) plus Fri-B (empty, 4 places).
async function clubWithTwoGroups() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  const [{ id: friB }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, '{}'::uuid[]) as id", [s25.id, FRI_4PM_PT]
  );
  await setPreferences(club, manager, { slots: [], timezone: LA });
  await setPreferences(club, sia, { slots: [WED_230PM_PT], timezone: LA });
  return { ...fixture, sia, friB };
}

describe('unplaced members', () => {
  test('the unplaced pool is members with availability who are on no roster', async () => {
    const { club, manager, s25, outsider } = await clubWithTwoGroups();
    await setPreferences(club, outsider, { slots: [WED_230PM_PT] });
    await club.register({ email: 'noavail@example.com', fullName: 'No Availability' });

    const pool = await club.as(manager).query('select full_name from unplaced_members($1)', [s25.id]);

    expect(pool).toEqual([{ full_name: 'Outsider' }]);
  });

  test('a member cannot list the unplaced pool', async () => {
    const { club, s25, sia } = await clubWithTwoGroups();

    await expect(club.as(sia).query('select * from unplaced_members($1)', [s25.id]))
      .rejects.toThrow(/only a club manager/i);
  });
});

describe('suggested groups for an unplaced member', () => {
  test('groups at a preferred time come first, each with its reason', async () => {
    const { club, manager, s25, outsider } = await clubWithTwoGroups();
    await setPreferences(club, outsider, { slots: [WED_230PM_PT, FRI_4PM_PT], preferred: FRI_4PM_PT });

    const suggestions = await club.as(manager).query(
      'select name, reason from suggested_groups($1, $2)', [outsider.id, s25.id]
    );

    expect(suggestions).toEqual([
      { name: 'Fri-B', reason: 'Available Fri 3:00 PM ★ preferred · 4 of 4 places open' },
      { name: 'Wed Mavericks', reason: 'Available Wed 1:30 PM · 1 of 4 places open' },
    ]);
  });

  test('groups whose time the member cannot attend are not suggested', async () => {
    const { club, manager, s25, outsider } = await clubWithTwoGroups();
    await setPreferences(club, outsider, { slots: [FRI_4PM_PT] });

    const suggestions = await club.as(manager).query(
      'select name from suggested_groups($1, $2)', [outsider.id, s25.id]
    );

    expect(suggestions).toEqual([{ name: 'Fri-B' }]);
  });

  test('a full group is not suggested', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithTwoGroups();
    const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
    await club.as(manager).query('select assign_member($1, $2, $3)', [kiran.id, groupId, s25.id]);
    await setPreferences(club, outsider, { slots: [WED_230PM_PT] });

    const suggestions = await club.as(manager).query(
      'select name from suggested_groups($1, $2)', [outsider.id, s25.id]
    );

    expect(suggestions).toEqual([]);
  });
});

describe("a group commander's prospective members", () => {
  test('a commander with a vacancy sees fit, preferences and what people are looking for — never email', async () => {
    const { club, s25, groupId, sia, outsider } = await clubWithTwoGroups();
    await setPreferences(club, outsider, {
      slots: [WED_230PM_PT], preferred: WED_230PM_PT, lookingFor: 'A supportive group of founders',
    });

    const pool = await club.as(sia).query('select * from prospective_members($1, $2)', [groupId, s25.id]);

    expect(pool).toEqual([{
      member_id: outsider.id, full_name: 'Outsider', timezone: LA,
      available: true, preferred: true, looking_for: 'A supportive group of founders',
      reason: 'Available Wed 1:30 PM ★ preferred',
    }]);
  });

  test('members who can attend the WAM time are listed first', async () => {
    const { club, s25, groupId, sia, outsider } = await clubWithTwoGroups();
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });
    await setPreferences(club, outsider, { slots: [FRI_4PM_PT] });
    await setPreferences(club, mia, { slots: [WED_230PM_PT] });

    const pool = await club.as(sia).query('select full_name from prospective_members($1, $2)', [groupId, s25.id]);

    expect(pool).toEqual([{ full_name: 'Mia' }, { full_name: 'Outsider' }]);
  });

  test('a commander whose group is full sees nobody', async () => {
    const { club, manager, s25, groupId, sia, outsider } = await clubWithTwoGroups();
    const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
    await club.as(manager).query('select assign_member($1, $2, $3)', [kiran.id, groupId, s25.id]);
    await setPreferences(club, outsider, { slots: [WED_230PM_PT] });

    const pool = await club.as(sia).query('select * from prospective_members($1, $2)', [groupId, s25.id]);

    expect(pool).toEqual([]);
  });

  test("a member who isn't the group's commander cannot browse the pool", async () => {
    const { club, s25, groupId, members: [, jessica] } = await clubWithTwoGroups();

    await expect(club.as(jessica).query('select * from prospective_members($1, $2)', [groupId, s25.id]))
      .rejects.toThrow(/only the group's commander/i);
  });
});

describe('availability that no longer fits', () => {
  test("club managers are told when a placed member's availability drops their group's time", async () => {
    const { club, manager, sia } = await clubWithTwoGroups();

    await setPreferences(club, sia, { slots: [FRI_4PM_PT] });

    const notices = await club.as(manager).query("select message from my_notices() where kind = 'availability_mismatch'");
    expect(notices).toEqual([
      { message: "Sia's availability no longer includes Wed Mavericks's WAM time (Season 25)." },
    ]);
  });
});
