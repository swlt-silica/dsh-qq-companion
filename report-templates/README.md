# Independent daily report adapter

The ATRI directory contains the installed SXP-Simon
`astrbot_plugin_qq_group_daily_analysis` v5.8.1 templates (and upstream MIT
license), copied from the migration source, not from old report artifacts.
`report-renderer.py` reuses the actual document and all four item templates.
Upstream templates remain byte-for-byte unchanged; the adapter replaces `safe`
filters in item templates with escaping at render time. Only escaped composed
item HTML is marked trusted in the document template. Quality colors and numeric
percentages are validated before CSS interpolation; model avatar/URL fields are
discarded by the schema validator.

## Host integration

Call `isReportDue(now)` from the host timer. It is true from 21:00 through
23:59:59 Asia/Shanghai; derive that local YYYY-MM-DD, then atomically
`claimReport(groupId,date)` in persistent SQLite **before** inference. A claimed,
failed or uncertain job must never automatically send again. Keep model output
and outgoing gates separate. This worker has no QQ client and cannot send.

`generateReport({groupId,date,messages,generate,outputDir,python,assetBase,
filterBots:false,maxMessages:1000,renderImage})` accepts normalized archived
`{id,userId,nickname,text,timestamp,isBot}` messages; timestamp is epoch
milliseconds. The host archive must retain the full local-day range from
`reportWindow(date)`, not merely recent wake context. Day counts use all unique
eligible archive messages; analysis uses the most recent maxMessages and records
truncation. Empty days do not call the model. Default bot inclusion matches the
live plugin's `filter_bot_messages=false`.

The injected `generate(prompt,context)` receives the requested selected model
`vulcan-guomo/deepseek-v4.1-flash` and empty tools. These are a contract, **not a
tool security boundary**: the host must create a restricted DSH preset/session,
select that provider/model, and enforce no general tools. No paid inference was
used during development. Model JSON is strictly validated; quoted text and title
user IDs must exist in the provided archive. Model schema mirrors the installed
SummaryTopic/UserTitle/GoldenQuote/QualityReview value objects. The installed
four separate AstrBot analyzers/provider interfaces are not imported; this is a
new single structured analysis call, so wording/quality is not asserted identical.

`python` defaults to REPORT_PYTHON or `python`; Python 3 and Jinja2 are required.
The result includes `{counts,analysis,artifact:{htmlPath,jsonPath,template,format}}`.
Artifacts are created exclusively under outputDir/group/date and never overwrite
old reports. OutputDir must be a dedicated trusted state directory (not old
AstrBot data). Existing report URLs/files/routes are outside this adapter.

For image output inject `renderImage(htmlPath,pngPath)`. On success the worker
checks PNG signature/IHDR/dimensions and returns `pngPath`, format `html+image`;
failure is explicit. The host must provide an isolated renderer using available
dependencies; the original image generator needs AstrBot's injected html_render
service and cannot be imported as an independent renderer. Test PNG injection
proves the adapter contract only, not actual screenshot rendering.

Default HTML rendering is offline: CSP blocks remote assets/scripts, and no
fetch/browser is invoked by Python. Fonts/background/GIF decoration need the
existing trusted ATRI asset mirror passed as `assetBase` (HTTPS only); offline
HTML retains the actual template layout/sections with system font fallback.
Model output cannot change assetBase. Emoji statistic is unavailable in the text
archive adapter; it is displayed as unknown rather than invented. Token use is
also unknown unless a future host adapter adds authoritative metrics.

Run `node scripts/test-report-worker.mjs`. Tests cover daily UTC+8 boundaries,
21:00 due behavior, archive deduplication and counts, configurable bot inclusion,
analysis bounds, empty days, schema/CSS validation, quote provenance, actual four
ATRI sections and hostile HTML escaping, plus injected image success/failure.
