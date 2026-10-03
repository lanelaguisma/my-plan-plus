import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

const SUNDAY_LATE = 6 * 1440 + 23 * 60 + 50; // Sunday 23:50 UTC: this week's WAM hasn't happened yet

// A healthy Wed Mavericks in week 4 of an active season: full (4 of 4),
// Sia commanding, everyone presumed at weeks 1-3, and a check-in last week.
async function healthyGroup() {
  const fixture = await clubWithWedMavericks({ rosterSize: 4 });
  const { club, manager, s25, groupId, members: [sia, jessica, shan, kiran] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner('update groups set slot_mow = $1 where id = $2', [SUNDAY_LATE, groupId]);
  await club.as(sia).query('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 3, 80)', [sia.id, s25.id]);
  await club.owner(
    `update cycles set status = 'active', start_date = (date_trunc('week', now()) - interval '21 days')::date,
       activated_at = date_trunc('week', now()) - interval '21 days' where id = $1`,
    [s25.id]
  );
  await club.owner("update group_members set joined_at = now() - interval '30 days'");
  return { ...fixture, sia, jessica, shan, kiran, g: [groupId, s25.id] };
}

async function flags({ club, manager, g: [groupId, seasonId] }, viewer = manager) {
  return club.as(viewer).query(
    'select flag, detail from group_health_flags($1, $2) order by flag', [groupId, seasonId]
  );
}
const codes = async (fixture, viewer) => (await flags(fixture, viewer)).map(f => f.flag);

describe('health flags', () => {
  test('a healthy group has no flags', async () => {
    expect(await codes(await healthyGroup())).toEqual([]);
  });

  test('no group commander', async () => {
    const fixture = await healthyGroup();
    await fixture.club.as(fixture.manager).query('select appoint_group_commander($1, $2, null)', fixture.g);

    expect(await flags(fixture)).toContainEqual({ flag: 'no_commander', detail: 'No group commander.' });
  });

  test('below the minimum size, with its vacancy', async () => {
    const fixture = await healthyGroup();
    for (const m of [fixture.shan, fixture.kiran]) {
      await fixture.club.as(fixture.manager).query('select remove_from_roster($1, $2)', [m.id, fixture.s25.id]);
    }

    expect(await flags(fixture)).toEqual([
      { flag: 'below_minimum', detail: '2 members — below the minimum of 3.' },
      { flag: 'vacancy', detail: '2 open places.' },
    ]);
  });

  test('an invitation unanswered for over 3 days', async () => {
    const fixture = await healthyGroup();
    const { club, sia, outsider, g } = fixture;
    await club.owner('update groups set capacity_override = 5 where id = $1', [g[0]]);
    const [{ id }] = await club.as(sia).query('select send_invitation($1, $2, $3) as id', [...g, outsider.id]);
    const fresh = await codes(fixture);
    await club.owner("update placement_offers set sent_at = now() - interval '4 days' where id = $1", [id]);

    expect([fresh.includes('stale_invitation'), await flags(fixture)]).toEqual([false, [
      { flag: 'stale_invitation', detail: '1 invitation unanswered for over 3 days.' },
      { flag: 'vacancy', detail: '1 open place.' },
    ]]);
  });

  test('not enough continuations during enrolment', async () => {
    const fixture = await healthyGroup();
    const { club, s25 } = fixture;
    await club.owner("update cycles set status = 'enrolling' where id = $1", [s25.id]);
    await club.owner("update group_members set status = 'awaiting_continuation' where cycle_id = $1 and user_id <> $2", [s25.id, fixture.sia.id]);

    expect(await flags(fixture)).toContainEqual({ flag: 'few_continuations', detail: 'Only 1 confirmed continuing — 3 needed.' });
  });

  test('attendance under 75% over the last 3 WAMs', async () => {
    const fixture = await healthyGroup();
    const { club, sia, jessica, g } = fixture;
    for (const week of [1, 2, 3]) {
      await club.as(sia).query('select confirm_attendance($1, $2, $3, $4::uuid[])', [...g, week, [sia.id, jessica.id]]);
    }

    expect(await flags(fixture)).toContainEqual({ flag: 'low_attendance', detail: 'Attendance 50% over the last 3 WAMs.' });
  });

  test('a member who missed the last 2 WAMs', async () => {
    const fixture = await healthyGroup();
    const { club, sia, jessica, kiran, g } = fixture;
    for (const week of [2, 3]) {
      await club.as(sia).query('select confirm_attendance($1, $2, $3, $4::uuid[])', [...g, week, [sia.id, jessica.id, kiran.id]]);
    }

    expect(await flags(fixture)).toContainEqual({ flag: 'missed_wams', detail: 'Shan missed the last 2 WAMs.' });
  });

  test('no check-ins last week, cleared by a check-in', async () => {
    const fixture = await healthyGroup();
    const { club, sia, jessica, s25 } = fixture;
    await club.owner('delete from checkins where user_id = $1', [sia.id]);
    const without = await codes(fixture);
    await club.as(jessica).query('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 3, 60)', [jessica.id, s25.id]);

    expect([without, await codes(fixture)]).toEqual([['no_checkins'], []]);
  });

  test('a pulse that says not working or asks for help', async () => {
    const fixture = await healthyGroup();
    const { club, jessica, s25 } = fixture;
    await club.as(jessica).query("select submit_pulse($1, 4, 'not_working', null, false)", [s25.id]);

    expect(await flags(fixture)).toContainEqual({ flag: 'pulse_concern', detail: 'Jessica: not working (week 4).' });
  });

  test("the group commander sees pulse concerns without who raised them", async () => {
    const fixture = await healthyGroup();
    const { club, jessica, sia, s25 } = fixture;
    await club.as(jessica).query("select submit_pulse($1, 4, 'so_so', null, true)", [s25.id]);

    expect(await flags(fixture, sia)).toEqual([
      { flag: 'pulse_concern', detail: '1 pulse says not working or asks for help.' },
    ]);
  });

  test('an open transfer request', async () => {
    const fixture = await healthyGroup();
    const { club, jessica, s25 } = fixture;
    await club.as(jessica).query("select request_transfer($1, 'Need Fridays')", [s25.id]);

    expect(await flags(fixture)).toContainEqual({ flag: 'transfer_request', detail: 'Jessica asked to transfer.' });
  });

  test("a member cannot see a group's health flags", async () => {
    const fixture = await healthyGroup();

    await expect(flags(fixture, fixture.jessica)).rejects.toThrow(/only the group's commander/i);
  });
});

describe('the club overview', () => {
  test('counts what needs a club manager\'s attention', async () => {
    const fixture = await healthyGroup();
    const { club, manager, s25, jessica, outsider, g } = fixture;
    await club.as(outsider).query("update profiles set slots = '[1]' where id = $1", [outsider.id]);
    await club.as(jessica).query("select request_transfer($1, 'Need Fridays')", [s25.id]);
    await club.as(manager).query('select appoint_group_commander($1, $2, null)', g);

    expect(await club.as(manager).query('select * from club_overview($1)', [s25.id])).toEqual([{
      unplaced: 1, without_commander: 1, below_minimum: 0, open_transfers: 1, at_risk: 1, groups: 1,
    }]);
  });
});

describe('at-risk notices', () => {
  test('club managers are told once when a group becomes at risk', async () => {
    const fixture = await healthyGroup();
    const { club, manager, jessica, shan, s25 } = fixture;

    await club.as(jessica).query("select request_transfer($1, 'Need Fridays')", [s25.id]);
    await club.as(shan).query("select request_transfer($1, 'Me too')", [s25.id]);

    expect(await club.as(manager).query("select message from my_notices() where kind = 'at_risk'")).toEqual([
      { message: 'Wed Mavericks is now at risk: Jessica asked to transfer.' },
    ]);
  });

  test('club managers are told when a group loses its commander', async () => {
    const fixture = await healthyGroup();
    const { club, sia, manager, s25 } = fixture;

    await club.as(sia).query('select leave_group($1)', [s25.id]);

    expect(await club.as(manager).query("select message from my_notices() where kind = 'lost_commander'")).toEqual([
      { message: 'Wed Mavericks no longer has a group commander.' },
    ]);
  });
});
