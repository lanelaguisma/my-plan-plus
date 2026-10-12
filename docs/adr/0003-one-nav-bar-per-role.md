# One navigation bar per role, chosen with a role switcher

Spec #41 gave each person a single navigation bar holding the union of their roles' tabs, and commander tools also sat inside the Group screen every member sees. Members, group commanders and club managers found it hard to tell what was theirs to do. We decided that each role gets its own bar: a person with more than one role picks Member, Commander or Club manager from a switcher in the header, and the bottom bar shows only that role's tabs, reminders and notices. The split is strict: member screens carry no commander or club manager tools, not even read-only ones. The app opens in the mode last used and never switches on its own.

## Considered Options

- **One combined bar** (the #41 model): one tap to anything, but role tools blur together and a commander can't see at a glance what the group needs from them.
- **Hub tabs**: keep the member bar and add one "Commander" and one "Club" tab, each opening a hub with its own inner tabs. Less switching, but still mixes roles on one bar and nests navigation two levels deep.
- **Two stacked bars**: everything visible at once, but costs screen height on phones and still mixes roles in one view.

## Consequences

- A commander or club manager doing their own check-in switches to Member mode first; the switcher shows a dot when another mode has open reminders so nothing is missed.
- Each notice and reminder is tagged with the role it belongs to, so it appears in exactly one mode.
- Per-person tab customisation from #41 stays, kept separately for each bar, with Reminders fixed first.
- Tab visibility is still cosmetic; permissions remain enforced in the database (ADR 0002).
