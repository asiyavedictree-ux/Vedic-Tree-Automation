# Vedic Tree daily YouTube collector

Runs on GitHub-hosted infrastructure with the PC switched off. Intended schedule:
daily 06:30 Asia/Kolkata (01:00 UTC). GitHub schedules are best effort, can be delayed
or dropped, and public-repository schedules may be disabled after 60 days without
repository activity. This is not an exact-time or always-on service guarantee.

## Setup and first live test

Repository Settings > Secrets and variables > Actions must contain:

- `YOUTUBE_API_KEY`
- `SUPABASE_URL` (existing Marketing Automation project)
- `SUPABASE_SERVICE_ROLE_KEY` (server-side service_role key, never anon)

Open Actions > Daily YouTube Preschool Updates > Run workflow > main.
Check both the GitHub run result and the `automation_runs` record named
`VT A0 - GitHub Daily YouTube Collector`. SUCCESS requires reading saved signal
metrics back from Supabase. Local tests do not validate live credentials.

After a successful run, refresh the existing marketing dashboard. The site must
read this project's `trend_signals`; this repository does not change the site or
add browser polling. Repeated videos retain their original discovery dates.

## Scope and safety

Reimplements only the connected YouTube branch of the supplied n8n A0 workflow.
Uses a seven-day search window, up to 25 candidates, and video durations up to
three minutes. This duration does not prove a video is a YouTube Short; new source
links use canonical watch URLs. Keeps source titles and matches statistics by video
ID, not response order. India is the search region, not verified creator location.
Trend/relevance scores are inherited heuristics, not official viral rankings or a
child-safety review. Missing view statistics cause failure rather than invented zeros.

Only writes `trend_signals` and `automation_runs`. Inserts are keyed by `signal_id`
and ignore existing IDs. Existing source titles, URLs and discovery dates are not
overwritten; only metrics and source metadata are refreshed. No schema changes,
deletions, approvals, creative briefs, Actions records, or automatic publishing.
Some rows may be saved before a later failure; reruns safely deduplicate by ID.

No Instagram, competitor monitoring, trending audio, A2/A3 generation, or public
approval permission changes are included. Static dashboard lists remain static.
No new qualifying content on a day is possible; successful statistics refresh does
not mean new videos were discovered. Empty/invalid collection results fail visibly.

Keep the existing n8n configuration as a fallback. Once the first cloud run is
verified, avoid concurrently scheduling the same YouTube collection locally.
Enable GitHub Actions failure notifications in your GitHub notification settings.
No custom alerts have been configured by this repository.

Never commit the original n8n export: it contains an embedded API key. Never put
secret values in files, issue comments, screenshots or workflow logs. GitHub
Secrets are available only to the collector step, not to the tests. Restrict write
access to this repository since trusted workflow editors can use these secrets.

## Tests

Node.js 22, no npm dependencies:

```sh
node --test tests/daily-youtube.test.mjs
```

References: [GitHub schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[YouTube video statistics](https://developers.google.com/youtube/v3/docs/videos/list).
