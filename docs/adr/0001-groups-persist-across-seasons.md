# Groups persist across seasons; membership is a per-season roster

The original schema tied each group to a single season (`groups.cycle_id`) and re-formed every group from scratch each season. We decided that a group is a lasting entity that outlives any one season, and that who is in it is recorded per season as its roster, with members confirming continuation during enrolment. The club's goal is groups that sustain themselves, and retention, vacancies and replacing departing members only mean something if the group carries over from one season to the next.

## Considered Options

- **Re-form groups every season** (the original model): simplest, but "retention" could then only mean within one season, and group commanders would have nothing lasting to build.
- **Membership carries over automatically until someone leaves**: rejected because members who quietly lapse would only show up as no-shows in week 1. Explicit continuation brings vacancies to light during enrolment instead.

## Consequences

- Season-scoped facts (roster, group commander, group state, WAMs, check-ins) attach to the group *for that season*, never to the group itself.
- Group history accumulates: health flags and retention can compare a group against its own past seasons.
