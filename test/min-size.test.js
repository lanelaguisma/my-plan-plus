import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup } from './fixtures.js';

const minSize = (club, person, groupId, size) =>
  club.as(person).query('select set_group_min_size($1, $2)', [groupId, size]);

describe('minimum size', () => {
  test('the club-wide minimum is 2, so a commanded pair is active', async () => {
    const { club, manager, s25, groupId, members: [sia] } = await clubWithWedMavericks({ rosterSize: 2 });
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    const g = await seasonGroup(club, sia, groupId, s25.id);
    expect([g.min_size, g.state]).toEqual([2, 'active']);
  });

  test("a club manager overrides a group's minimum, and the group follows it", async () => {
    const { club, manager, s25, groupId, members: [sia] } = await clubWithWedMavericks({ rosterSize: 3 });
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await minSize(club, manager, groupId, 4);

    const g = await seasonGroup(club, sia, groupId, s25.id);
    expect([g.min_size, g.min_size_override, g.min_size_set_by, g.state]).toEqual([4, 4, manager.id, 'forming']);
  });

  test("the group's commander can set it too, and clearing it returns to the club default", async () => {
    const { club, manager, s25, groupId, members: [sia] } = await clubWithWedMavericks({ rosterSize: 3 });
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await minSize(club, sia, groupId, 3);
    const set = await seasonGroup(club, sia, groupId, s25.id);
    await minSize(club, sia, groupId, null);
    const cleared = await seasonGroup(club, sia, groupId, s25.id);

    expect([set.min_size, set.min_size_set_by, cleared.min_size, cleared.min_size_set_by]).toEqual([3, sia.id, 2, null]);
  });

  test('ordinary members and other groups\' commanders cannot change it', async () => {
    const { club, manager, s25, groupId, members: [sia, jessica], outsider } = await clubWithWedMavericks({ rosterSize: 3 });
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
    const [{ id: other }] = await club.as(manager).query(
      "select create_season_group($1, 'Fri Owls', 100, $2::uuid[]) as id", [s25.id, [outsider.id]]
    );
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [other, s25.id, outsider.id]);

    await expect(minSize(club, jessica, groupId, 3)).rejects.toThrow(/only a club manager or this group's commander/i);
    await expect(minSize(club, outsider, groupId, 3)).rejects.toThrow(/only a club manager or this group's commander/i);
  });

  test('it must be between 2 and the group\'s capacity', async () => {
    const { club, manager, groupId } = await clubWithWedMavericks();

    await expect(minSize(club, manager, groupId, 1)).rejects.toThrow(/between 2 and the group's capacity \(4\)/i);
    await expect(minSize(club, manager, groupId, 5)).rejects.toThrow(/between 2 and the group's capacity \(4\)/i);
    await club.owner('update groups set capacity_override = 6 where id = $1', [groupId]);
    await minSize(club, manager, groupId, 5);
  });

  test('health flags use the effective minimum', async () => {
    const { club, manager, s25, groupId, members: [sia] } = await clubWithWedMavericks({ rosterSize: 3 });
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
    const flags = async () => (await club.as(manager).query(
      "select detail from group_health_flags($1, $2) where flag = 'below_minimum'", [groupId, s25.id]
    )).map(f => f.detail);

    const before = await flags();
    await minSize(club, manager, groupId, 4);

    expect([before, await flags()]).toEqual([[], ['3 members — below the minimum of 4.']]);
  });

  test('the override carries into the next season', async () => {
    const { club, manager, s25, groupId, members } = await clubWithWedMavericks({ rosterSize: 3 });
    await minSize(club, manager, groupId, 3);
    const [s26] = await club.owner(
      "insert into cycles (name, start_date, status) values ('Season 26', '2027-04-05', 'setup') returning id"
    );
    await club.owner('insert into group_seasons (group_id, cycle_id) values ($1, $2)', [groupId, s26.id]);

    expect((await seasonGroup(club, members[0], groupId, s26.id)).min_size).toBe(3);
  });
});
