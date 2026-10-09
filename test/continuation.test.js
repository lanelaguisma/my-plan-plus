import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';
import { seasonGroup, FRI_4PM_PT, WED_230PM_PT } from './fixtures.js';

// Season 24 running with Fri-B (Iain commanding, Cameron, Strong) and a
// dormant Wed Mavericks; Season 25 created but not yet open for enrolment.
async function clubBetweenSeasons() {
  const club = await freshClub();
  const manager = await club.register({ email: 'manager@example.com', fullName: 'Manager' });
  await club.makeClubManager(manager);
  const [s24] = await club.owner(
    "insert into cycles (name, start_date, status) values ('Season 24', '2026-10-05', 'active') returning id"
  );
  const [s25] = await club.owner(
    "insert into cycles (name, start_date, status) values ('Season 25', '2027-01-04', 'setup') returning id"
  );
  const people = {};
  for (const name of ['Iain', 'Cameron', 'Strong', 'Sia']) {
    people[name.toLowerCase()] = await club.register({ email: `${name.toLowerCase()}@example.com`, fullName: name });
  }
  const { iain, cameron, strong, sia } = people;
  const [{ id: friB }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s24.id, FRI_4PM_PT, [iain.id, cameron.id, strong.id]]
  );
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s24.id, iain.id]);
  const [{ id: wed }] = await club.as(manager).query(
    "select create_season_group($1, 'Wed Mavericks', $2, $3::uuid[]) as id", [s24.id, WED_230PM_PT, [sia.id]]
  );
  await club.as(manager).query('select set_group_dormant($1, $2, true)', [wed, s24.id]);
  return { club, manager, s24, s25, friB, wed, ...people };
}

async function openEnrolment(fixture) {
  await fixture.club.as(fixture.manager).query('select open_enrolment($1)', [fixture.s25.id]);
}

async function continuations(club, viewer, groupId, seasonId) {
  return club.as(viewer).query(
    'select member_name, status from group_continuations($1, $2) order by member_name', [groupId, seasonId]
  );
}

describe('opening enrolment', () => {
  test("each group's roster is carried into the next season awaiting continuation", async () => {
    const fixture = await clubBetweenSeasons();
    const { club, iain, friB, s25 } = fixture;

    await openEnrolment(fixture);

    expect(await continuations(club, iain, friB, s25.id)).toEqual([
      { member_name: 'Cameron', status: 'awaiting_continuation' },
      { member_name: 'Iain', status: 'awaiting_continuation' },
      { member_name: 'Strong', status: 'awaiting_continuation' },
    ]);
  });

  test('the group commander carries over too', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, sia, friB, s25 } = fixture;

    await openEnrolment(fixture);

    expect((await seasonGroup(club, sia, friB, s25.id)).commander_name).toBe('Iain');
  });

  test('dormant groups are not carried over', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, sia, wed, s25 } = fixture;

    await openEnrolment(fixture);

    expect(await seasonGroup(club, sia, wed, s25.id)).toBeUndefined();
  });

  test('opening enrolment twice changes nothing', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, iain, friB, s25 } = fixture;
    await openEnrolment(fixture);
    await club.as(iain).query('select confirm_continuation($1, true)', [s25.id]);

    await openEnrolment(fixture);

    expect((await continuations(club, iain, friB, s25.id)).find(c => c.member_name === 'Iain').status).toBe('on_roster');
  });

  test('a member cannot open enrolment', async () => {
    const fixture = await clubBetweenSeasons();

    await expect(fixture.club.as(fixture.iain).query('select open_enrolment($1)', [fixture.s25.id]))
      .rejects.toThrow(/only a club manager/i);
  });
});

describe('confirming continuation', () => {
  test('a member who confirms stays on the roster', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, iain, cameron, friB, s25 } = fixture;
    await openEnrolment(fixture);

    await club.as(cameron).query('select confirm_continuation($1, true)', [s25.id]);

    expect((await continuations(club, iain, friB, s25.id)).find(c => c.member_name === 'Cameron').status).toBe('on_roster');
  });

  test('a member who declines frees their place', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, sia, cameron, friB, s25 } = fixture;
    await openEnrolment(fixture);

    await club.as(cameron).query('select confirm_continuation($1, false)', [s25.id]);

    expect((await seasonGroup(club, sia, friB, s25.id)).vacancies).toBe(2);
  });

  test('members still awaiting continuation leave vacancies when the season starts', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, manager, sia, iain, cameron, friB, s25 } = fixture;
    await openEnrolment(fixture);
    await club.as(iain).query('select confirm_continuation($1, true)', [s25.id]);
    await club.as(cameron).query('select confirm_continuation($1, true)', [s25.id]);

    await club.as(manager).query("update cycles set status = 'active' where id = $1", [s25.id]);

    expect((await seasonGroup(club, sia, friB, s25.id)).member_count).toBe(2);
  });

  test("a group commander who doesn't confirm loses the role when the season starts", async () => {
    const fixture = await clubBetweenSeasons();
    const { club, manager, sia, cameron, friB, s25 } = fixture;
    await openEnrolment(fixture);
    await club.as(cameron).query('select confirm_continuation($1, true)', [s25.id]);

    await club.as(manager).query("update cycles set status = 'active' where id = $1", [s25.id]);

    expect((await seasonGroup(club, sia, friB, s25.id)).commander_name).toBeNull();
  });
});

describe('continuation reminders and progress', () => {
  test('a member awaiting continuation has a reminder, counting down, until they answer', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, cameron, s25 } = fixture;
    await openEnrolment(fixture);
    const [{ days }] = await club.owner("select ('2027-01-03'::date - current_date) as days");

    const before = await club.as(cameron).query("select message, action, role, overdue from my_reminders() where kind = 'continuation'");
    await club.as(cameron).query('select confirm_continuation($1, true)', [s25.id]);
    const after = await club.as(cameron).query("select message from my_reminders() where kind = 'continuation'");

    expect([before, after]).toEqual([
      [{ message: `Are you continuing with Fri-B for Season 25? ${days} days left to confirm.`, action: 'confirm_continuation', role: 'member', overdue: false }],
      [],
    ]);
  });

  test('it is overdue in the last 3 days, and no longer a notice', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, manager, cameron, s25 } = fixture;
    await openEnrolment(fixture);
    await club.as(manager).query('select set_season_enrolment_dates($1, null, current_date + 1)', [s25.id]);

    expect([
      await club.as(cameron).query("select message, overdue from my_reminders() where kind = 'continuation'"),
      await club.as(cameron).query("select key from my_notices() where kind = 'continuation'"),
    ]).toEqual([[{ message: 'Are you continuing with Fri-B for Season 25? 1 day left to confirm.', overdue: true }], []]);
  });

  test('club managers see continuation progress for every group', async () => {
    const fixture = await clubBetweenSeasons();
    const { club, manager, iain, cameron, s25 } = fixture;
    await openEnrolment(fixture);
    await club.as(iain).query('select confirm_continuation($1, true)', [s25.id]);
    await club.as(cameron).query('select confirm_continuation($1, false)', [s25.id]);

    const progress = await club.as(manager).query(
      'select group_name, confirmed, awaiting, declined from continuation_progress($1)', [s25.id]
    );

    expect(progress).toEqual([{ group_name: 'Fri-B', confirmed: 1, awaiting: 1, declined: 1 }]);
  });

  test("a member cannot see another group's continuations", async () => {
    const fixture = await clubBetweenSeasons();
    const { club, sia, friB, s25 } = fixture;
    await openEnrolment(fixture);

    await expect(continuations(club, sia, friB, s25.id)).rejects.toThrow(/only the group's commander/i);
  });
});
