import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

const FRI_4PM_PT = 5 * 1440 + 23 * 60; // Friday 16:00 PDT = Friday 23:00 UTC

// Fixture: a lasting group running in two seasons, with a roster for each.
async function friBAcrossTwoSeasons() {
  const club = await freshClub();
  const iain = await club.register({ email: 'iain@example.com', fullName: 'Iain' });
  const cameron = await club.register({ email: 'cameron@example.com', fullName: 'Cameron' });
  const carol = await club.register({ email: 'carol@example.com', fullName: 'Carol' });
  const [s24] = await club.owner(
    "insert into cycles (name, start_date, status) values ('Season 24', '2026-10-05', 'active') returning id"
  );
  const [s25] = await club.owner(
    "insert into cycles (name, start_date, status) values ('Season 25', '2027-01-04', 'enrolling') returning id"
  );
  const [friB] = await club.owner(
    "insert into groups (name, slot_mow) values ('Fri-B', $1) returning id", [FRI_4PM_PT]
  );
  const roster = { [s24.id]: [iain, cameron], [s25.id]: [cameron, carol] };
  for (const [seasonId, people] of Object.entries(roster)) {
    await club.owner('insert into group_seasons (group_id, cycle_id) values ($1, $2)', [friB.id, seasonId]);
    for (const person of people) {
      await club.owner(
        'insert into group_members (group_id, cycle_id, user_id) values ($1, $2, $3)',
        [friB.id, seasonId, person.id]
      );
    }
  }
  return { club, iain, cameron, carol, s24, s25, friB };
}

describe('group-mates are per season', () => {
  test("a member joining a lasting group cannot see the previous season's check-ins", async () => {
    const { club, iain, carol, s24 } = await friBAcrossTwoSeasons();
    await club.as(iain).query(
      'insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 1, 80)', [iain.id, s24.id]
    );

    const seenByCarol = await club.as(carol).query('select score from checkins');

    expect(seenByCarol).toEqual([]);
  });

  test('a member joining a lasting group cannot see members from only a previous season', async () => {
    const { club, carol } = await friBAcrossTwoSeasons();

    const seen = await club.as(carol).query('select full_name from profiles order by full_name');

    expect(seen).toEqual([{ full_name: 'Cameron' }, { full_name: 'Carol' }]);
  });

  test('group-mates in the same season still see each other', async () => {
    const { club, iain, cameron, s24 } = await friBAcrossTwoSeasons();
    await club.as(iain).query(
      'insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 1, 80)', [iain.id, s24.id]
    );

    const seenByCameron = await club.as(cameron).query('select score from checkins');

    expect(seenByCameron).toEqual([{ score: 80 }]);
  });
});

describe('creating season groups', () => {
  test('a member who creates their own group is on its roster for that season', async () => {
    const { club, carol, s25 } = await friBAcrossTwoSeasons();
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });

    const [{ id }] = await club.as(mia).query(
      "select create_season_group($1, 'Momentum Collective', $2, array[$3]::uuid[]) as id",
      [s25.id, FRI_4PM_PT, mia.id]
    );

    const groups = await club.as(carol).query(
      'select name, member_count from season_groups where id = $1 and cycle_id = $2', [id, s25.id]
    );
    expect(groups).toEqual([{ name: 'Momentum Collective', member_count: 1 }]);
  });

  test('a member cannot put other people into a group they create', async () => {
    const { club, carol, s25 } = await friBAcrossTwoSeasons();
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });

    const creating = club.as(mia).query(
      "select create_season_group($1, 'Momentum Collective', $2, array[$3, $4]::uuid[])",
      [s25.id, FRI_4PM_PT, mia.id, carol.id]
    );

    await expect(creating).rejects.toThrow(/only a club manager/i);
  });

  test('a member cannot be on two rosters in the same season', async () => {
    const { club, carol, s25 } = await friBAcrossTwoSeasons();

    const secondGroup = club.as(carol).query(
      "select create_season_group($1, 'Second', $2, array[$3]::uuid[])", [s25.id, FRI_4PM_PT, carol.id]
    );

    await expect(secondGroup).rejects.toThrow(/already on a roster/i);
  });

  test('a club manager places several people in a new group at once', async () => {
    const { club, carol, s25 } = await friBAcrossTwoSeasons();
    const manager = await club.register({ email: 'manager@example.com', fullName: 'Manager' });
    await club.makeClubManager(manager);
    const mia = await club.register({ email: 'mia@example.com', fullName: 'Mia' });
    const sia = await club.register({ email: 'sia@example.com', fullName: 'Sia' });

    const [{ id }] = await club.as(manager).query(
      "select create_season_group($1, 'Group 5', $2, array[$3, $4]::uuid[]) as id",
      [s25.id, FRI_4PM_PT, mia.id, sia.id]
    );

    const [group] = await club.as(carol).query(
      'select member_count from season_groups where id = $1 and cycle_id = $2', [id, s25.id]
    );
    expect(group).toEqual({ member_count: 2 });
  });
});

describe('migrating to lasting groups', () => {
  test('an existing season group keeps its roster after the migration', async () => {
    const club = await freshClub({ upTo: '0001' });
    const iain = await club.register({ email: 'iain@example.com', fullName: 'Iain' });
    const cameron = await club.register({ email: 'cameron@example.com', fullName: 'Cameron' });
    const [s24] = await club.owner(
      "insert into cycles (name, start_date, status) values ('Season 24', '2026-10-05', 'active') returning id"
    );
    const [friB] = await club.owner(
      "insert into groups (cycle_id, name, slot_mow) values ($1, 'Fri-B', $2) returning id",
      [s24.id, FRI_4PM_PT]
    );
    for (const person of [iain, cameron]) {
      await club.owner(
        'insert into group_members (group_id, user_id, cycle_id) values ($1, $2, $3)',
        [friB.id, person.id, s24.id]
      );
    }

    await club.migrate();

    const roster = await club.as(iain).query(
      `select p.full_name, r.status from group_members r join profiles p on p.id = r.user_id
       where r.group_id = $1 and r.cycle_id = $2 order by p.full_name`,
      [friB.id, s24.id]
    );
    expect(roster).toEqual([
      { full_name: 'Cameron', status: 'on_roster' },
      { full_name: 'Iain', status: 'on_roster' },
    ]);
  });
});
