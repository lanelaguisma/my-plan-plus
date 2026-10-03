import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup } from './fixtures.js';

describe('appointing group commanders', () => {
  test('a club manager appoints a group commander from the roster', async () => {
    const { club, manager, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks();

    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).commander_name).toBe('Sia');
  });

  test('someone not on the roster cannot be appointed', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithWedMavericks();

    const appointing = club.as(manager).query(
      'select appoint_group_commander($1, $2, $3)', [groupId, s25.id, outsider.id]
    );

    await expect(appointing).rejects.toThrow(/must be on the group's roster/i);
  });

  test('a member cannot appoint a group commander', async () => {
    const { club, s25, groupId, members: [sia] } = await clubWithWedMavericks();

    const appointing = club.as(sia).query(
      'select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]
    );

    await expect(appointing).rejects.toThrow(/only a club manager/i);
  });

  test('a club manager replaces a group commander mid-season', async () => {
    const { club, manager, s25, groupId, members: [sia, jessica], outsider } = await clubWithWedMavericks();
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, jessica.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).commander_name).toBe('Jessica');
  });

  test('a group whose commander is cleared is forming again', async () => {
    const { club, manager, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks();
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await club.as(manager).query('select appoint_group_commander($1, $2, null)', [groupId, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).state).toBe('forming');
  });
});
