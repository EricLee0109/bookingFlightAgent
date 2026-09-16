# Booking Flight Agent Business Rules

These rules are mandatory for future implementation in this project.

1. Separate functions by clear responsibility. Each helper should own one job.
2. Add a short comment for each component/helper/function that explains its main responsibility.
3. Do not keep raw Playwright codegen inside business flows. Move selectors and UI actions into named helpers.
4. Do not pass raw AI output directly into Playwright automation.
5. Always validate data before automation.
6. Always capture an error screenshot when Playwright fails.
7. Do not hardcode routes in production flow. Routes must come from validated input.
8. All automation must use the shared 1Booking viewport.
9. Capture case-scoped, timestamped screenshots at material 1Booking UI checkpoints so website UI drift can be compared later. Additional hold-audit screenshot failures are warnings and must never block or retry a hold booking.
10. Before interacting with the search form or results, dismiss the optional promotion image-slider modal and `LƯU Ý QUAN TRỌNG` drawer, and verify their masks are hidden. Match the promotion by its dialog/carousel/image-slider structure and scoped `Đóng` button; never close login or booking-review dialogs generically or force-click through overlays. Save timestamped promotion before/after screenshots (case prefix when available), including after auth refresh.
11. Long polling is only for local MVP Telegram Bot integration and for passing values into `searchFlights()`.
12. Future webhook migration must only change the transport layer. Do not rewrite parser, validation, mapper, or automation business logic.
13. Enforce hold-confirmation settings in the hold service. Passenger attachment is not hold approval. Bind approval to chat, current flight/fare/passenger details and expiry; consume it once before browser execution.
14. Persist an exclusive hold claim and the final-submit intent before the irreversible click. Never retry a potentially submitted booking automatically, including after process restart.
15. SDK shadow tools never execute external actions. Keep model input minimal, disable sensitive tracing, and preserve SQLite passenger resolution when live adapters are introduced. See `HYBRID_AGENT_ARCHITECTURE.md` for the phased migration.

## Hybrid search pilot rules

The `hybrid_search` mode is an exclusive Telegram search route. It is checked
before hold recovery, hold selection, passenger parsing, and their callbacks,
and it runs only for an authorized allowlisted chat when the saved settings
enable the agent and automatic flight search. Its SDK tool catalog contains
clarification, case inspection, validated search, and deterministic snapshot
filter/compare operations. Flight selection and personal passenger confirmation
are handled by the separate customer flow below; this search agent cannot
execute a booking action.

The legacy parser schema remains unchanged. Pilot requests use a separate
provider-compatible root schema and are validated against the airport and
airline catalogs before Playwright starts. Search stores every parsed result,
including candidates excluded by a filter, in a chat-owned snapshot with
stable local IDs and screenshot batches. A failed refresh keeps the previous
snapshot but marks the new attempt as failed; its old results must not be
presented as refreshed results. A same-route/date follow-up may filter the
fresh snapshot without reopening the browser. Route/date changes and explicit
refreshes create a new snapshot.

Dates and departure times are evaluated in `Asia/Ho_Chi_Minh`. A yearless
date resolves to its next valid occurrence, including February 29. Invalid or
past dates require clarification. A same-day request requires an explicit
earliest departure threshold, and cached comparisons exclude departures that
have already passed. Around-time requests use the existing clamped two-hour
window and announce the resolved interval; exact, directional, and between
constraints preserve both inclusive/exclusive endpoints. Unknown airlines,
unknown candidate IDs, malformed bounds, and conflicting bounds fail closed.

## Hybrid proposal reliability (2026-09-16)

LLM output is a proposal. Before search, compare or clarification, run the same
field validator against the current message and the verified draft. Resolve both
airport names and codes against the shared catalog; disagreement is a conflict,
not permission to prefer the code. Collect all alias matches. Do not infer an
ambiguous route from catalog order. Evidence must occur in the current message;
invalid changes cannot replace verified facts as accepted values. Unknown or
unmeasurable criteria require a targeted clarification. Greetings/help do not
modify search fields. Airline and time negations not supported by the existing
filters require clarification rather than conversion to an opposite filter.

An initial request starts a fresh draft. Later proposals distinguish new_search,
update_search and unsure. A new search drops old optional filters and must provide
required route/date facts. Updates preserve unchanged fields; explicit clearing
needs field-specific evidence. Synchronize the retained comparison criterion on
validated ranking changes and clears in every tool, including cached search; an
older criterion must never override a newly requested ranking. Pending clarification identifies the field a short
answer may fill. Optional session metadata preserves version-1 compatibility;
old drafts are revalidated before reuse. Missing facts cannot be satisfied by a
retained value while that field is pending. Explicit year wording must agree with
the current Vietnam date and any supplied year; yearless dates retain the existing
next-valid-occurrence rule.

Use one shared recovery budget for missing tool calls and invalid proposals:
at most two model decisions per user message, one executable decision tool per
model decision, and never recover after automation has been invoked. A repair
receives the current message, verified draft and structured field errors. Validate
the repair identically. On repeated invalid input, ask only unresolved fields.
On a repair timeout/429, retain the first safe clarification. Do not retry provider
errors at the HTTP layer in hybrid (maxRetries=0). Other AI clients keep their
existing defaults. Browser/service failures never trigger model recovery.

Reuse caseId BK-YYYYMMDD-HHMMSS as the request case, snapshotId as the saved
observation and candidateId only inside that snapshot. No new ID system is added.
Check chat ownership, snapshot identity/freshness and current route/date before
reuse. Unresolved route/date/intent or changed route/date invalidate freshness;
keep old snapshots for audit without advertising them as current results. The
allowlisted group-chat ownership policy remains unchanged. A turnId is diagnostic
correlation only, not a booking identifier.

Diagnostics contain tool, final outcome (clarification differs from searched),
validation status/catalog codes by field and decision, recovery count and whether
automation was invoked. Never log keys, full prompts, passenger data or raw model
responses. Test model/browser fixtures must stay offline in isolated temporary
storage. Completion requires airport/relevant regression suites, production build
and diff checks; report live Telegram verification separately. Selection, verified
SQLite passenger lookup, confirmation invalidation and hold execution remain in
the existing legacy flow until the next authorized phase.

## Hybrid filtered screenshot rules (2026-09-16)

Capture each observed flight card as an immutable image for hybrid full snapshots,
with a one-to-one candidate-ID mapping in that snapshot. Pin the DOM element and
reparse its flight/time/fare fields before and after capture; reject changed cards
and discard their images rather than bind them to an earlier candidate. Filtered Telegram replies
must show exactly the candidate IDs listed in the text, in the same order. Reuse
original captured pixels and timestamps; do not regenerate flight/fare content.
A flight is currently sent as one separate image. Keep legacy grouped capture unchanged.

Older grouped screenshots may only be sent when their entire contents and order
match the displayed selection, with complete coverage. Otherwise omit the images
and explain that an explicit refresh is needed for exact flight images. Do not
guess crop boundaries, send an unfiltered image as a filtered result, or trigger
a live search just to obtain an image without an explicit refresh request.
Persisted snapshot/candidate identity remains the authority after restart. Test
capture using local HTML fixtures and distinguish it from live 1Booking verification.

## Resuming search intent clarification (2026-09-16)

Explicit new/update control wording and a complete, directed current-message search
request take precedence over an inconsistent model mode label. Do not ask the user
to resolve a model metadata conflict when the request intent is already clear.
Location/fare/time validation still applies; this does not permit guessing facts.
The shared airport catalog includes whole-token hn as Hanoi/HAN.

When intent is truly unresolved, keep the active draft separate from an optional
pendingClarification.intentDraft. Stage only fields that pass the current-message
validator against a fresh draft, never copied filters from the old request. A short
explicit intent answer may adopt these already verified facts after restart without
requiring the user to repeat their evidence. A confirmed new search starts with only
these staged facts; a confirmed update combines them with unchanged active facts.
Unresolved fields still block execution, and model edits not present in the staged
draft require current-message evidence. Vague answers must not consume the pending
request. Keep the existing two-decision recovery budget and all booking boundaries.
Old version-1 sessions remain readable; do not migrate/reset user conversations just
to recover intent. Log the resolved mode and confirmation boolean, not raw prompts.

## Lean Internal-Agent Scope

Keep:
- Telegram Bot Long Polling
- Playwright automation
- AI parser / mock parser boundary
- Local screenshots for debug
- Local JSON settings
- Local case memory files
- Telegram commands for settings
- In-memory automation lock

Legacy / not in current scope:
- Redis
- BullMQ
- Large dashboard
- PostgreSQL
- Cloud screenshot storage
- Public webhook server
- Full production deployment

## Hybrid result pagination (2026-09-16)

- Search/compare/inspect display up to 5 verified flights per page. Show the current range and total navigable results; page-specific price range must not be described as the full result price range.
- Telegram exposes Previous/Next controls after the corresponding screenshots. The final page may contain fewer than 5 flights. All page images must resolve from the selected candidate IDs in the same snapshot, in the same order.
- A persisted resultView stores the snapshot binding, ranked candidate IDs, page size and request fingerprint. Its random token is a UI cursor, not a replacement business identifier. Old sessions may omit it.
- Page callbacks bypass LLM and browser. Revalidate mode/settings, chat, current snapshot freshness and identity, validated route/date, unchanged request/criterion, unresolved fields, page bounds and candidate membership/order. Existing group-chat allowlist policy remains unchanged.
- A new displayed result creates a new cursor. Changed request/filter, failed refresh, pending clarification or changed departure eligibility blocks old controls; ask for the latest result view. Restart preserves valid cursors. Replayed callback IDs are suppressed under the same per-chat lock as search turns.
- Navigation uses saved observations and preserves capturedAt. It does not refresh prices, create a booking case, choose a flight, modify passengers or hold a booking. Existing legacy callback guards remain active.
- Previously sent Telegram messages do not gain buttons retroactively. Ask to view results again to receive new controls; no data reset is needed. Existing missing/exact-screenshot fallback still applies.
- Offline verification covers 57 results across 12 pages, matching evidence, ranking, restart, replay, stale/foreign/invalid callbacks and unchanged legacy boundaries. Live Telegram/1Booking verification is separate and has not been performed for this change.

## Customer-owned hybrid passenger flow (2026-09-16)

- The hybrid customer flow supports one passenger in a private Telegram chat. The existing allowlist remains the rollout gate; account administration and public enrollment are not implemented. Group chats may search, but passenger entry directs users to a private chat without copying group data or profiles.
- Select a flight only through controls bound to the current result-view token and verified case/snapshot/candidate IDs. Recheck route/date, request fingerprint, pending fields, time eligibility and exact candidate values before selection and confirmation. UI tokens are not new business identifiers.
- Personal profiles live in a separate customer_passenger_profiles table in the existing SQLite file. Never import, link or merge legacy shared profiles based on names/DOB. All lookup/list/update SQL includes the authenticated Telegram owner ID. Names alone are never a uniqueness key.
- Full name, explicit gender and full-year DOB are mandatory. Show surname and remaining names separately for customer correction. The SDK proposes fields supported by the current message; code validates evidence, calendar dates and unresolved edits. Do not infer gender from a person's name. Do not put a full profile directory, raw provider output or passenger messages into operational logs.
- The case owns the durable draft, missing/unresolved fields, selected IDs, UI revision and confirmed copy; the search session retains only its case pointer. Restart does not erase passenger progress. Greeting messages preserve data.
- Draft edits apply to this case only. Confirmation freezes a separate copy in the case. Saving a new personal profile is a distinct opt-in after confirmation; no reply or “Chỉ dùng lần này” creates no directory record. Updating an existing profile requires a before/after preview and a second explicit action with optimistic profile version checking.
- New flight/request/snapshot, passenger edits or pending search clarification invalidate prior confirmation. Preserve the draft for re-selection; reject old controls, cross-owner IDs and replayed callback IDs. Browsing/searching personal profiles never accesses another owner's records.
- HYBRID_PASSENGER_DRAFT and HYBRID_DETAILS_CONFIRMED are deliberately separate from legacy passenger-ready/hold states. Do not populate legacy attachedPassengerInfo/selectedFlight or create holdApproval. Even when legacy automatic hold settings are enabled, these customer handlers never open passenger forms, submit holds or request a PNR.
- Confirmation text must explicitly say “Thông tin đã được xác nhận, chưa giữ chỗ.” Display the observed price and capturedAt, not a promise of a current or held fare.
- Regression tests use temporary databases/cases/sessions and fake SDK/browser/Telegram adapters. Live Telegram and 1Booking validation are reported separately.

- Approved age policy (2026-09-16): every passenger in the hybrid customer flow must be at least 18 on the departure date. The 18th birthday is eligible; one day before is not. HYBRID_PASSENGER_MINIMUM_AGE defaults to 18 and only 18 is supported; invalid or lower configuration blocks confirmation. Local and example configuration are set to 18. This does not expand the flow into hold booking.

### DOB normalization boundary (2026-09-16)

- The passenger SDK requests YYYY-MM-DD, but code accepts equivalent full-year Vietnamese day/month/year proposals and canonicalizes them before validation. Do not rely on provider formatting or JavaScript locale date parsing.
- Proposal and current-message evidence use the same date grammar/calendar checks. Exactly one matching real date is required; invalid competing dates, swapped day/month, future DOB and unsupported/missing years are rejected. Existing draft is never current-message evidence.
- A valid DOB is retained and clears its unresolved field even if deployment age configuration is invalid. The approved default is 18; invalid overrides still prevent confirmation. Asking repeatedly for an already-valid DOB is not a remedy for configuration errors.
