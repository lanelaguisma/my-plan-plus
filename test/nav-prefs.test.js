import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

const tabsOf = async (club, person) =>
  (await club.as(person).query('select nav_prefs from profiles where id = $1', [person.id]))[0].nav_prefs;

describe('navigation preferences', () => {
  test('a member saves their own tabs and can reset them to the defaults', async () => {
    const { club, members: [sia] } = await clubWithWedMavericks();
    const prefs = { tabs: ['checkin', 'dashboard'], known: ['dashboard', 'checkin', 'goals'] };

    await club.as(sia).query('select set_nav_prefs($1)', [prefs]);
    const saved = await tabsOf(club, sia);
    await club.as(sia).query('select set_nav_prefs(null)');

    expect([saved, await tabsOf(club, sia)]).toEqual([prefs, null]);
  });

  test("a club manager cannot change someone else's tabs", async () => {
    const { club, manager, members: [sia] } = await clubWithWedMavericks();

    await expect(club.as(manager).query(
      "update profiles set nav_prefs = '{\"tabs\":[\"learn\"]}' where id = $1", [sia.id]
    )).rejects.toThrow(/only you can change your own tabs/i);
  });

  test('a club manager can still edit the rest of a profile', async () => {
    const { club, manager, members: [sia] } = await clubWithWedMavericks();

    await club.as(manager).query("update profiles set full_name = 'Sia R' where id = $1", [sia.id]);

    expect((await club.as(sia).query('select full_name from profiles where id = $1', [sia.id]))[0].full_name).toBe('Sia R');
  });

  test('tabs must be a list', async () => {
    const { club, members: [sia] } = await clubWithWedMavericks();

    await expect(club.as(sia).query('select set_nav_prefs($1)', [{ tabs: 'dashboard' }]))
      .rejects.toThrow(/tabs must be a list/i);
  });
});
