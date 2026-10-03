import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

const WED_230PM_PT = 2 * 1440 + 21 * 60 + 30; // Wednesday 14:30 PDT = Wednesday 21:30 UTC

// Fixture: Season 25 enrolling, a club manager, and Wed Mavericks running
// in it with `rosterSize` members (the first appointed commander if asked).
async function wedMavericks({ rosterSize, withCommander = false }) {
  const club = await freshClub();
  const manager = await club.register({ email: 'manager@example.com', fullName: 'Manager' });
  await club.makeClubManager(manager);
  const [s25] = await club.owner(
    "insert into cycles (name, start_date, status) values ('Season 25', '2027-01-04', 'enrolling') returning id"
  );
  const members = [];
  for (const name of ['Sia', 'Jessica', 'Shan', 'Kiran', 'Johnson'].slice(0, rosterSize)) {
    members.push(await club.register({ email: `${name.toLowerCase()}@example.com`, fullName: name }));
  }
  const [{ id: groupId }] = await club.as(manager).query(
    "select create_season_group($1, 'Wed Mavericks', $2, $3::uuid[]) as id",
    [s25.id, WED_230PM_PT, members.map(m => m.id)]
  );
  if (withCommander) {
    await club.owner('update group_seasons set commander_id = $1 where group_id = $2', [members[0].id, groupId]);
  }
  const outsider = await club.register({ email: 'outsider@example.com', fullName: 'Outsider' });
  return { club, manager, s25, groupId, members, outsider };
}

async function profileOf({ club, outsider, groupId, s25 }) {
  const [profile] = await club.as(outsider).query(
    'select * from season_groups where id = $1 and cycle_id = $2', [groupId, s25.id]
  );
  return profile;
}

describe('group state', () => {
  test('a group below the minimum size is forming', async () => {
    const fixture = await wedMavericks({ rosterSize: 2, withCommander: true });

    expect((await profileOf(fixture)).state).toBe('forming');
  });

  test('a group without a group commander is forming', async () => {
    const fixture = await wedMavericks({ rosterSize: 3 });

    expect((await profileOf(fixture)).state).toBe('forming');
  });

  test('a group at the minimum size with a group commander is active', async () => {
    const fixture = await wedMavericks({ rosterSize: 3, withCommander: true });

    expect((await profileOf(fixture)).state).toBe('active');
  });

  test('a club manager can set a group dormant for a season', async () => {
    const fixture = await wedMavericks({ rosterSize: 3, withCommander: true });
    const { club, manager, groupId, s25 } = fixture;

    await club.as(manager).query('select set_group_dormant($1, $2, true)', [groupId, s25.id]);

    expect((await profileOf(fixture)).state).toBe('dormant');
  });
});

describe('size rules', () => {
  test('vacancies are the club-wide capacity minus the roster', async () => {
    const fixture = await wedMavericks({ rosterSize: 3, withCommander: true });

    const profile = await profileOf(fixture);

    expect({ capacity: profile.capacity, vacancies: profile.vacancies }).toEqual({ capacity: 4, vacancies: 1 });
  });

  test("a club manager's capacity override changes a group's vacancies", async () => {
    const fixture = await wedMavericks({ rosterSize: 3, withCommander: true });
    const { club, manager, groupId } = fixture;

    await club.as(manager).query('update groups set capacity_override = 6 where id = $1', [groupId]);

    expect((await profileOf(fixture)).vacancies).toBe(3);
  });

  test("a member cannot change a group's capacity", async () => {
    const fixture = await wedMavericks({ rosterSize: 3, withCommander: true });
    const { club, members, groupId } = fixture;

    await club.as(members[0]).query('update groups set capacity_override = 6 where id = $1', [groupId]);

    expect((await profileOf(fixture)).vacancies).toBe(1);
  });
});

describe('group profiles', () => {
  test("any member sees a group's purpose, time and group commander", async () => {
    const fixture = await wedMavericks({ rosterSize: 3, withCommander: true });
    const { club, manager, groupId } = fixture;
    await club.as(manager).query(
      "update groups set emoji = '🐹', purpose = 'Founders building a side business' where id = $1", [groupId]
    );

    const profile = await profileOf(fixture);

    expect({
      emoji: profile.emoji, name: profile.name, purpose: profile.purpose,
      slot: profile.slot_mow, commander: profile.commander_name, members: profile.member_count,
    }).toEqual({
      emoji: '🐹', name: 'Wed Mavericks', purpose: 'Founders building a side business',
      slot: WED_230PM_PT, commander: 'Sia', members: 3,
    });
  });

  test("a member outside a group cannot see its other members' profiles", async () => {
    const { club, outsider } = await wedMavericks({ rosterSize: 3, withCommander: true });

    const seen = await club.as(outsider).query('select full_name from profiles order by full_name');

    expect(seen).toEqual([{ full_name: 'Manager' }, { full_name: 'Outsider' }]);
  });
});
