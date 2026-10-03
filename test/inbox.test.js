import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, FRI_4PM_PT } from './fixtures.js';

async function noticesOf(club, person) {
  return club.as(person).query('select key, kind, message, action, read from my_notices() order by created_at');
}

describe('the inbox', () => {
  test('an assigned member gets a notice naming their group', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithWedMavericks();

    await club.as(manager).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);

    const notices = await noticesOf(club, outsider);
    expect(notices.map(({ kind, message, action, read }) => ({ kind, message, action, read }))).toEqual([
      { kind: 'assigned', message: "You've been assigned to Wed Mavericks for Season 25.", action: 'view_group', read: false },
    ]);
  });

  test("nobody else can read a member's notices", async () => {
    const { club, manager, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks();
    await club.as(manager).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);

    const seenBySia = await club.as(sia).query('select count(*)::int as n from notices where recipient_id <> auth.uid()');

    expect(seenBySia).toEqual([{ n: 0 }]);
  });

  test('marking a notice read takes it off the unread count', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithWedMavericks();
    await club.as(manager).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);
    const [notice] = await noticesOf(club, outsider);

    await club.as(outsider).query('select mark_notice_read($1)', [notice.key]);

    expect(await club.as(outsider).query('select unread_notice_count() as n')).toEqual([{ n: 0 }]);
  });

  test('saving an allocation notifies everyone placed', async () => {
    const { club, manager, s25, outsider } = await clubWithWedMavericks();
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });

    await club.as(manager).query(
      "select create_season_group($1, 'Group 5', $2, $3::uuid[])", [s25.id, FRI_4PM_PT, [outsider.id, mia.id]]
    );

    const kinds = [(await noticesOf(club, outsider))[0]?.kind, (await noticesOf(club, mia))[0]?.kind];
    expect(kinds).toEqual(['assigned', 'assigned']);
  });
});
