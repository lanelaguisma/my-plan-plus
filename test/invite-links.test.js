import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';
import { clubWithWedMavericks } from './fixtures.js';

async function registerWithCode(club, email, code) {
  const [row] = await club.owner(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
    [email, { full_name: 'Newcomer', invite_code: code }]
  );
  return { id: row.id, email };
}

const codeOf = async (club, person) =>
  (await club.as(person).query('select invite_code from profiles where id = $1', [person.id]))[0].invite_code;

describe('invite links', () => {
  test('everyone has their own invite code', async () => {
    const { club, members: [sia, jessica] } = await clubWithWedMavericks();

    const [a, b] = [await codeOf(club, sia), await codeOf(club, jessica)];

    expect([a.length >= 12, a === b]).toEqual([true, false]);
  });

  test('registering through a link records who invited the newcomer, who joins unplaced', async () => {
    const { club, manager, s25, members: [sia] } = await clubWithWedMavericks();

    const mia = await registerWithCode(club, 'mia@example.com', await codeOf(club, sia));
    await club.as(mia).query("update profiles set slots = '[1]' where id = $1", [mia.id]);

    expect([
      (await club.as(manager).query('select invited_by from profiles where id = $1', [mia.id]))[0].invited_by,
      (await club.as(manager).query('select full_name from unplaced_members($1)', [s25.id])).map(r => r.full_name),
    ]).toEqual([sia.id, ['Newcomer']]);
  });

  test('an unknown code still registers the newcomer, with no inviter', async () => {
    const club = await freshClub();

    const mia = await registerWithCode(club, 'mia@example.com', 'not-a-real-code');

    expect(await club.as(mia).query('select email, invited_by from profiles where id = $1', [mia.id]))
      .toEqual([{ email: 'mia@example.com', invited_by: null }]);
  });

  test('nobody can change who invited them, or their code', async () => {
    const { club, manager, members: [sia, jessica] } = await clubWithWedMavericks();

    await expect(club.as(sia).query('update profiles set invited_by = $1 where id = $2', [jessica.id, sia.id]))
      .rejects.toThrow(/can't be changed/i);
    await expect(club.as(manager).query("update profiles set invite_code = 'mine' where id = $1", [sia.id]))
      .rejects.toThrow(/can't be changed/i);
  });

  test('only a club manager changes the default invite message', async () => {
    const { club, manager, members: [sia] } = await clubWithWedMavericks();

    await club.as(sia).query("update club_settings set invite_message = 'Join us {link}'");
    const afterMember = (await club.as(sia).query('select invite_message from club_settings'))[0].invite_message;
    await club.as(manager).query("update club_settings set invite_message = 'Come along: {link} — {name}'");

    expect([afterMember.includes('{link}') && afterMember !== 'Join us {link}',
      (await club.as(sia).query('select invite_message from club_settings'))[0].invite_message])
      .toEqual([true, 'Come along: {link} — {name}']);
  });
});
