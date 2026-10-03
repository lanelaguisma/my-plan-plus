# My Plan+ Community — Setup Guide

`myPlanPlus-community.html` is the multi-user edition of My Plan+. It adds:

- **Registration & sign-in** — people create an account with name, email and password.
- **Availability nomination** — each person ticks the weekly **45-minute session** times they can attend (handled correctly across time zones), and can mark one as their **preferred** time (★) — allocation favours preferred times.
- **Choose or create your own group** — once a cycle is active or open for sign-up, members can join an existing group or create their own (name + weekly session time, typical size 4). Anyone who doesn't choose is covered by random allocation. The NEXT cycle can be **open for sign-up while the current one is still running**, so the following 12-week year gets organised in advance.
- **Random group allocation** — the admin panel randomly allocates everyone who hasn't picked a group into new groups that share a nominated time (existing groups are kept). Admins can also create groups directly and place or remove anyone (manual placement can exceed the typical size of 4).
- **Gated planning tools** — once someone is in a group, the full My Plan+ tool unlocks: 12-week focus (goals & tactics), weekly check-ins, reports.
- **Team accountability scoreboard** — saving a weekly check-in shares it automatically: the **Team** tab shows your group's member-by-week score grid, each member's five check-in answers, a combined team score with trend chart, and a scoreboard of every group's combined weekly scores (the modern replacement for the shared Google Sheet tracker).
- **Message boards** — every group has its own private message board, and admins can create community-wide boards that all registered users can read and post on.
- **Email** — members can email their group-mates (individually or the whole group); admins can email an individual, a group, or all registered users. Email buttons open a pre-addressed draft in the sender's own mail app (recipients in BCC) — the system does not send mail itself.
- **Cloud-saved plans + export** — each member's plan syncs privately to their account, and everyone can still export JSON backups / PDF+CSV archives from Settings; admins can export registrant/group lists.

The original single-user `myPlanPlus.html` is untouched and still works as before.

It needs a free [Supabase](https://supabase.com) project as its backend (accounts + database). One-time setup, about 15 minutes:

## 1. Create the Supabase project

1. Go to https://supabase.com and sign up (free tier is fine), then **New project**.
2. Pick any project name (e.g. `myplanplus`), a strong database password (store it somewhere safe — you won't need it day-to-day), and a region near your members (e.g. Sydney).

## 2. Create the database

1. In the Supabase dashboard, open **SQL Editor → New query**.
2. Run each file in `supabase/migrations/` **in filename order** (`0000_baseline.sql` first): paste its entire contents and click **Run**.
   You should see "Success. No rows returned" for each.

> **Upgrading an existing project?** Only run the migrations your database hasn't had yet, in order. A project set up from the old `supabase-schema.sql` plus `supabase-update-1..4.sql` is already at `0000_baseline.sql`, so start from `0001`. Never edit a migration once it has been applied anywhere; add a new one instead.

## 3. Connect the app to the project

1. In Supabase, open **Project Settings → API** (or "Data API").
2. Copy the **Project URL** and the **anon / public key**.
3. Open `myPlanPlus-community.html` in a text editor, find the `CONFIG` block near the top of the `<script>` section, and paste both values:

```js
const CONFIG = {
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...'
};
```

The anon key is designed to be public — what each signed-in user can see and change is enforced by the row-level security rules in the schema (e.g. plan entries are private to each member; only admins can create cycles and groups).

## 4. Host the app

Upload **`myPlanPlus-community.html`** and **`MyPlan+.png`** to any static web host:

- your existing logic2design.com hosting, or
- Netlify Drop (drag-and-drop, free): https://app.netlify.com/drop, or
- GitHub Pages.

Rename the HTML file to `index.html` on the host if you want a clean URL. HTTPS hosting is required for sign-in to work reliably.

Then in Supabase, open **Authentication → URL Configuration** and set **Site URL** to the app's address (e.g. `https://myplan.logic2design.com/`) and add it to **Redirect URLs**. This makes email confirmation and password-reset links land back in the app.

## 5. Make yourself the admin

1. Open the hosted app and **register** your own account.
2. Back in Supabase, run this in the SQL Editor (with your email):

```sql
update public.profiles set is_admin = true where email = 'ijd1965@gmail.com';
```

3. Reload the app — you'll now see the **Admin Panel** (via the Group tab or Settings).

## 6. Running a 12-week year

1. **People register** via the app link you share, and tick their availability on the **Group** tab (45-minute session start times, shown in each person's own time zone).
2. In the **Admin Panel**, **Create Cycle** — name (e.g. "Q1 2027") and start date — then **Open sign-up**. People can now join or create groups for it from the Group tab (groups typically hold 4) — even while a previous cycle is still running. When it's time to start, click **Make active** (the previously active cycle is archived automatically).
3. When sign-up closes, run **Randomly Allocate Ungrouped People** in the Admin Panel: choose min/max size (default 3–4) and click allocate. It only covers people who nominated availability but haven't picked a group — chosen groups are kept. It repeatedly finds the session time the most unassigned people share and forms randomly-selected, balanced groups. Re-run for a different mix, then **Save This Allocation**. Anyone with no shared time appears as "Not allocated" — place them manually from the registrants table (manual placement can exceed the typical size).
4. Add a **meeting link** (Zoom/Meet) to each group. Members then see their group, its meeting time, members and message board, and the planning tools unlock with cycle dates pre-filled.
5. Members set their 12-week focus in **Goals**, record their **Check-in** each week, and use their **group message board** (plus any community boards you create) between sessions. Each saved check-in feeds the **Team** tab: the group's score grid and answers, the combined team trend, and the all-groups scoreboard everyone can see.
6. **Backups/exports**: each member can export their full plan (JSON) or archive the cycle (PDF + CSV) from **Settings**. Admins can export the registrants/groups lists (CSV or JSON) from the Admin Panel. Goals, tactics and unsaved notes stay private to each member; a **saved weekly check-in (score + the five answers) is shared with the member's group** for accountability, and the **score alone** feeds the community-wide scoreboard.
7. For the **next** 12-week year: create the new cycle and **Open sign-up** while the current one is still running — people choose or create groups, you pre-allocate the rest (pick the new cycle in the allocation Cycle selector) — then **Make active** on changeover day. Members archive + reset their previous cycle from Settings.

## Notes & limits

- **Email confirmation**: by default Supabase sends a confirmation email on signup (the app handles the "check your email" step). To let people in instantly, turn off *Confirm email* under **Authentication → Sign In / Up → Email**. The built-in Supabase email service is fine for small communities; for larger volumes configure custom SMTP.
- **Time zones**: availability is stored as UTC minutes-of-week, so a Melbourne 7 pm and an Auckland 9 pm are matched correctly. Everyone always sees times in their own local zone. (Daylight-saving shifts of an hour around changeover dates are possible for cross-zone groups.)
- **Privacy**: members can see the names/time zones of their own group only; admins can see all registrants (name, email, availability). Plan data is private per member.
- **Old data**: if a member previously used the offline `myPlanPlus.html` in the same browser, the new app offers to import that data into their account on first sign-in.
