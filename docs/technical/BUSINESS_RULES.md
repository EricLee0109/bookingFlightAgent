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
9. Long polling is only for local MVP Telegram Bot integration and for passing values into `searchFlights()`.
10. Future webhook migration must only change the transport layer. Do not rewrite parser, validation, mapper, or automation business logic.

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
