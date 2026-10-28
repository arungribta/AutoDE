# Realistic estate fixture

A deliberately messy estate for tests (v0.50.3): what the tidy retail-orders reference problem doesn't have.

| File | System / environment | What it exercises |
|---|---|---|
| `erp_prod.sql` | erp / prod | `ORDERS` in two databases (`RETAIL`, `ARCHIVE`) and two schemas (`SALES`, `STAGING`); a cryptic legacy name (`T_ORD_HDR`); no foreign keys |
| `erp_dev.sql` | erp / dev | The same fully qualified `RETAIL.SALES.ORDERS` in another environment |
| `crm_prod.sql` | crm / prod | The same fully qualified `RETAIL.SALES.ORDERS` in another system (another account) |
| `legacy.sql` | legacy / prod | DDL that names no database, and a table with no schema |

Ingest each with its system and environment (`parseFile(text, name, { system, environment })`).
