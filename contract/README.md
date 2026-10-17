# API contract

Canonical request/response examples for the Owed HTTP API (`/api/v1`). Both `plugin/src/contract.ts` and `web/lib/contract.ts` must parse every file here; each side has a test that does.

Error codes: `invalid_input`, `rate_limited`, `not_found`, `upstream_unavailable`, `blocked`.
Amounts are decimal strings in token units. Status values: `open`, `paid`, `underpaid`, `cancelled`, `not_found`, `invalid`.
