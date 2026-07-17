# @nusend/api-contract

Shared TypeScript package for Nusend **CLI-consumed codecs**, **permission catalog**, and **route catalog**.

## Current scope

- Error envelope codes and pagination helpers
- Auth device-authorization + `/me` schemas
- API keys request/response schemas
- Contacts and mailings schemas used by the CLI/service boundary
- Permission sets and route path catalog

## Intentionally incomplete

Response schemas for **lists**, **suppressions**, **operations**, and full SES admin surfaces are **not** fully modeled here yet. The service implements those domains with local types. Expanding the contract package is future work — do not half-adopt new dual DTOs without completing the boundary.
