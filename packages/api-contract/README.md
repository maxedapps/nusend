# @nusend/api-contract

Shared TypeScript package for Nusend **CLI-consumed codecs**, **permission catalog**, and **route catalog**.

## Current scope

- Error envelope codes and pagination helpers
- Auth device-authorization + `/me` schemas
- API keys request/response schemas
- Contacts, lists/imports, suppressions, and mailing schemas used by the CLI/service boundary
- Operations/delivery and SES administration response schemas
- Permission sets and encoded route path catalog

The schemas describe HTTP wire structure. Service decoders remain authoritative for normalization, limits, property-presence rules, and business validation.
