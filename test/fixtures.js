import { freshClub } from './harness.js';

export const WED_230PM_PT = 2 * 1440 + 21 * 60 + 30; // Wednesday 14:30 PDT = 21:30 UTC
export const FRI_4PM_PT = 5 * 1440 + 23 * 60;        // Friday 16:00 PDT = 23:00 UTC

// A club with one club manager, Season 25 open for enrolment, and Wed
// Mavericks running in it with the first `rosterSize` of Sia, Jessica,
// Shan, Kiran and Johnson on its roster. `outsider` is registered but
// on no roster.
export async function clubWithWedMavericks({ rosterSize = 3 } = {}) {
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
  const outsider = await club.register({ email: 'outsider@example.com', fullName: 'Outsider' });
  return { club, manager, s25, groupId, members, outsider };
}

export async function seasonGroup(club, viewer, groupId, seasonId) {
  const [row] = await club.as(viewer).query(
    'select * from season_groups where id = $1 and cycle_id = $2', [groupId, seasonId]
  );
  return row;
}
