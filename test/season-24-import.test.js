import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { freshClub } from './harness.js';

const IMPORT = readFileSync(new URL('../supabase/seeds/season_24_import.sql', import.meta.url), 'utf8');
const FRI_4PM_PDT = 4 * 1440 + 23 * 60;      // Friday 23:00 UTC
const WED_230PM_PDT = 2 * 1440 + 21 * 60 + 30; // Wednesday 21:30 UTC

async function clubWithSomeRegistered() {
  const club = await freshClub();
  const viewer = await club.register({ email: 'viewer@example.com', fullName: 'Viewer' });
  for (const name of ['Iain Dunn', 'Cameron Cherry', 'Sia', 'kiran alphonso ']) {
    await club.register({ email: `${name.trim().split(' ')[0].toLowerCase()}@example.com`, fullName: name });
  }
  return { club, viewer };
}

async function s24Groups(club, viewer) {
  return club.as(viewer).query(
    `select sg.emoji, sg.name, sg.slot_mow, sg.member_count, sg.vacancies, sg.state
     from season_groups sg join cycles c on c.id = sg.cycle_id
     where c.name = 'Season 24' order by sg.name`
  );
}

describe('Season 24 import', () => {
  test('the four tracker groups arrive with their emojis and WAM times', async () => {
    const { club, viewer } = await clubWithSomeRegistered();

    await club.ownerScript(IMPORT);

    expect((await s24Groups(club, viewer)).map(({ emoji, name, slot_mow }) => ({ emoji, name, slot_mow }))).toEqual([
      { emoji: '🐴', name: 'Fri-Avengers', slot_mow: FRI_4PM_PDT },
      { emoji: '🐻', name: 'Fri-B', slot_mow: FRI_4PM_PDT },
      { emoji: '🐧', name: 'Momentum Collective', slot_mow: FRI_4PM_PDT },
      { emoji: '🐹', name: 'Wed Mavericks', slot_mow: WED_230PM_PDT },
    ]);
  });

  test('Fri-Avengers arrives forming, with its four reserved places as vacancies', async () => {
    const { club, viewer } = await clubWithSomeRegistered();

    await club.ownerScript(IMPORT);

    const friAvengers = (await s24Groups(club, viewer)).find(g => g.name === 'Fri-Avengers');
    expect({ state: friAvengers.state, vacancies: friAvengers.vacancies }).toEqual({ state: 'forming', vacancies: 4 });
  });

  test('registered tracker members are placed on their rosters, matched by name', async () => {
    const { club, viewer } = await clubWithSomeRegistered();

    await club.ownerScript(IMPORT);

    expect((await s24Groups(club, viewer)).map(g => [g.name, g.member_count])).toEqual([
      ['Fri-Avengers', 0], ['Fri-B', 2], ['Momentum Collective', 1], ['Wed Mavericks', 1],
    ]);
  });

  test('tracker members who have not registered are listed for the club manager', async () => {
    const { club } = await clubWithSomeRegistered();

    const unmatched = await club.ownerScript(IMPORT);

    expect(unmatched.map(r => r.unregistered_member)).toEqual([
      'Eviana', 'Jack Lee', 'Jessica', 'Johnson Eung', 'Shan', 'Strong',
    ]);
  });

  test('running the import twice changes nothing', async () => {
    const { club, viewer } = await clubWithSomeRegistered();
    await club.ownerScript(IMPORT);
    const once = await s24Groups(club, viewer);

    await club.ownerScript(IMPORT);

    expect(await s24Groups(club, viewer)).toEqual(once);
  });
});
