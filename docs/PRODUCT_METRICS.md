# Aggregate product metrics

Use the read-only summary after migrations 001–014 are applied:

```powershell
$env:METRICS_DATABASE_URL = "postgresql://..."
pnpm product:metrics -- --days 30
```

The command emits one JSON object with counts, conversion-style rates and mean
report latency and first-view engagement. It reads only non-deleted sessions and prints no user ID, session
ID, scenario identity, code, notes, transcript, report content or support detail.
It is suitable for recording a small-beta release snapshot without making a
candidate-level analytics export.

`activatedVoice` means the reviewed oral brief was delivered, which occurs only
after browser preflight and a ready provider session. `recoveredInterviews` means
a session contains both connection-loss and connection-restored evidence.
`returningAccounts` means at least two non-deleted attempts in the selected
window. `reportEngagement` compares ready reports with reports opened at least
once; its timestamp stays on the deletable report record. These definitions are
deliberately derived from server-owned records.

Landing visits and Supabase signups are not inferred. Read those aggregate values
from the web host and Supabase Auth dashboards and record them beside this output.
Do not enable client fingerprinting or export Auth users to fill that gap.

This snapshot is measurement tooling, not launch evidence by itself. Run it on
staging and the controlled beta, record provider cost for the same window, and
keep the admission cap no higher than tested capacity.
