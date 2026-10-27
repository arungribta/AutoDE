-- Masks 2 personal-data column(s) of CURATED.STAGING.STG_CUSTOMERS (non-reversible).
CREATE OR REPLACE VIEW CURATED.STAGING.STG_CUSTOMERS_MASKED AS
SELECT
  customer_id,
  CASE WHEN email IS NULL THEN NULL ELSE encode(sha256(convert_to(CONCAT(CAST(secret('pii', 'salt') AS TEXT), CAST(email AS TEXT)), 'UTF8')), 'hex') END AS email,
  CASE WHEN password IS NULL THEN NULL ELSE '***' END AS password
FROM CURATED.STAGING.STG_CUSTOMERS;
