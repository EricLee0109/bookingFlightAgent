# Hybrid search pilot verification

Status on 2026-09-14: implementation, manager offline review, regression tests and production build passed. After direct OpenAI returned HTTP 429, the selected 9Router provider passed the complete live-model evaluator with isolated state and fake browser data. Actual Telegram delivery remains a manual check. This is a search-only pilot; this record does not assert full end-to-end acceptance or deployment readiness.

## Responsibilities

- Luna MAX, data: request validation, time filters, full snapshots and contract tests.
- Luna MAX, orchestration: SDK tools, conversation state, Telegram routing and integration tests.
- Luna MAX, popup: delayed promotion handling and focused browser regressions.
- Manager: independent review, reproduction of findings, live read-only verification and final build gate.

## Verified on 2026-09-14

- Baseline shadow/approval, flight parser and passenger parser contracts passed.
- A real OpenAI call with the configured `gpt-5.6-luna` model proposed `search_flights`; shadow execution remained paused.
- Saved 1Booking authentication opened the dashboard without a login prompt. Credentials were not submitted.
- Live search exposed a promotion appearing after the initial overlay sweep. The airport locator resolved correctly, but the modal intercepted pointer events.
- An exact promotion locator handler resolved that failure. The production helper then completed a headless SGN–HAN search for 2026-09-21, returning 45 candidates.
- The manager independently reran all six promotion regressions successfully, including late appearance, repeated sweeps and delayed wrapper removal.
- Full snapshot capture returned 45 candidates, five screenshot batches and 45 mapped candidate IDs.
- Filtering that captured snapshot from departures at/after 08:00 to departures after 10:00 preserved all 45 candidates and returned the expected five cheapest matching flights without browser access.
- After correcting Sun PhuQuoc code parsing, a real SDK search tool with a saved-auth browser adapter returned **56/56 observed flights**, including all 11 `9G` cards, with six complete screenshot batches. The manager visually checked the batch containing the recorded Sun cards. Only the relevant batch was selected for the five-flight response.
- Real OpenAI runs demonstrated clarification, one search, cached comparison without another browser call, explicit refresh, unsupported booking response, and yearless-date continuation to 2027-07-30. These were component/sequence checks during review, not a complete pass of the final evaluator.
- A final full-sequence rerun could not finish: the provider returned `429 Rate limit reached` for the configured model. The final plain-17h policy and deterministic time corrections passed offline tests but still need a fresh live-model acceptance run. The final 56-card live cached follow-up also remains unverified after the last fixes.
- The application now reports an OpenAI rate-limit error clearly and does not fall back to legacy handling or mislabel a missing SDK outcome as an unsupported user request.

Generated evidence is under the ignored `screenshots/` directory:

- `hybrid-manager-baseline-error-20260914.png`: original live failure.
- `hybrid-manager-baseline-20260914.json` and numbered PNGs: live hypothesis verification.
- `hybrid-manager-snapshot-20260914.json` and numbered PNGs: production full-snapshot verification.
- `hybrid-manager-unparsed-cards.json`: all 11 skipped Sun card texts used as regression evidence.
- `hybrid-manager-live-search-20260914.json` and `hybrid-manager-live-1789373322955-*.png`: accepted 56-card live observation and six screenshot batches.

## Findings returned for correction

- Yearless dates initially swapped day/month. Independently reproduced inputs `30/07` and `29/02` now resolve to 2027-07-30 and 2028-02-29 when today is 2026-09-14.
- Missing airports and malformed time constraints must fail validation instead of becoming an unrestricted search.
- Provider-facing schemas must be root objects compatible with OpenAI strict structured output.
- Inclusive/exclusive bounds must survive every layer through the final departure-time predicate.
- Cached results need current-time checks, including when the departure date has already passed.
- Missing prices must produce an explicit unrankable result, not an apparently successful empty comparison.
- Unknown airlines, foreign snapshot IDs and unknown candidate IDs must not silently disappear during normalization.
- The first integration import failed because Zod does not allow `.partial()` on a refined object. Patch schemas now use the object shape and validate through the full request boundary.
- A real OpenAI request rejected `temperature` for the configured model. Removing that parameter allowed real SDK tool calls to complete.
- Clarification and search-error outcomes must retain empty screenshot arrays; optional outcome fields must not overwrite transport defaults with `undefined`.
- Real model evaluation confirmed clarification → search → cached filter → explicit refresh. A booking request initially repeated the snapshot; explicit unsupported routing corrected that response without exposing booking tools.
- Strict live completeness checking exposed 56 UI results versus 45 parsed candidates. The missing 11 cards were Sun PhuQuoc Airways flights with visible `9G` codes; the old parser recognized only `9S`. The earlier 45-card observation is therefore partial evidence, not a complete-search acceptance result.

## Self-review lessons

- A successful initial popup sweep does not prove later UI actions are unobstructed. Reproduce late overlays with actionability checks rather than increasing arbitrary sleeps or force-clicking.
- Capture mask/wrapper handles before modal content unmounts; their fade-out can outlive the content locator.
- Fake model tests alone do not verify provider schema compatibility. Exercise schema conversion and a real API call as separate checks.
- Preserve the complete observed result set before ranking or truncation. Otherwise a later conversational filter cannot recover omitted flights.
- Keep live search verification separate from booking actions. No flight selection, passenger mutation or hold is needed to verify this pilot.
- Verify the parser's supported codes against observed cards. A stable result count alone cannot establish complete parsing, and silently dropped cards can invalidate a cheapest-flight claim.
- Test real SDK decisions as well as deterministic adapters. Required tool choice still needs explicit instructions for unsupported requests and the agreed plain-17h interpretation.
- Normalize explicit time operators at the application boundary: a model must not turn “sau 10h” into inclusive “từ 10h”. Time-token boundaries must also prevent `25h` from being read as the valid suffix `5h`.
- SDK outcome defaults must remain valid through failure paths, and corrupt persisted data must be rejected before it reaches transport formatting.

## Final offline verification

- Manager independently passed the hybrid request/snapshot, SDK/session and Telegram transport suites, the recorded airline-card suite, and the existing shadow/approval, flight parser, passenger parser/cache, browser configuration, Telegram error sanitizer and native dependency suites.
- Browser tests passed **10/10**, serially: six promotion regressions and four empty/settling/parser-count regressions.
- The final SDK/session suite covers malformed model times, explicit-time correction, unsupported airline/past date, no matches, missing prices, disabled settings, failed refresh, durable replay after more than 100 messages and restart, per-chat serialization, corrupt state and HTTP 429.
- `pnpm build` and `git diff --check` passed after the final application changes.
- Every Luna MAX member completed a scoped implementation/QA step and returned self-review lessons. Manager review findings were sent back for correction. No global memory was written.

## 9Router acceptance update

The manager verified the user-provided 9Router key against `http://localhost:20128/v1` with advertised model `cx/gpt-5.6-luna`. Both strict function tools and flight-parser structured JSON succeeded. Provider configuration keeps the OpenAI and router keys separate and rejects missing router credentials/model rather than falling back.

The complete evaluator passed through the selected provider: eight live model turns and one duplicate replay, covering clarification, search, cached filtering, explicit refresh, unsupported hold requests, yearless-date continuation and the plain-17h 15:00–19:00 policy. It used synthetic 40-flight results and three fake browser searches; cached filtering and replay did not trigger additional searches. A separate real SDK probe using the saved 56-flight snapshot passed search and cached follow-up (44 matches from 08:00, then 38 after 10:00).

The first router evaluation exposed an existing timeout bug: string models ignored the evaluator's 30-second override and timed out after the default 15 seconds. The override now applies to real and injected models. The local `HYBRID_SEARCH_MODEL_TIMEOUT_MS` is 30000; the repository default remains 15000. The complete rerun passed without HTTP 429. This does not guarantee that the upstream provider will never rate-limit future calls.

Evidence: isolated evaluator state in `C:\Users\letha\AppData\Local\Temp\hybrid-search-eval-VELfmd`, and the local `screenshots/9router-sdk-probe.ts` harness. Neither test submitted Telegram messages or booking actions. See [9Router setup and verification](NINE_ROUTER_SETUP.md).

## Local startup and remaining live check

The local `.env` now uses `AGENT_ORCHESTRATION_MODE=hybrid_search`. Existing settings have `agentEnabled=true`, `autoSearchFlights=true`, and `autoHoldBooking=false`. The repository default remains legacy. No additional Telegram poller was started by this verification.

Start from the repository root with `pnpm run telegram:dev`. The startup log must show `Telegram Agent orchestration mode: hybrid_search`.

The local configuration selects 9Router. To repeat the accepted real-model evaluator, run `pnpm run eval:hybrid-search`; it uses isolated state and fake browser data. Stop any old bot process and restart it, then manually exercise Telegram with a future travel date: request SGN–HAN with “rẻ nhưng đừng bay quá sớm”, answer “từ 8h”, refine to “sau 10h”, and request “cập nhật giá mới”. Check that filtering reuses the snapshot and only an explicit refresh searches again. Startup should also show `Telegram Agent AI provider: 9router; model: cx/gpt-5.6-luna.`

The final live-model evaluator is accepted through 9Router. Actual Telegram delivery remains outstanding. No 1Booking login credentials, real Telegram messages, flight selections, passenger mutations or holds were submitted during this work.
