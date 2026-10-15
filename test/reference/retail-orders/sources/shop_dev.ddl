-- The shop system's DEV environment: the same table names as production, one column
-- ahead of it. Imported as system "shop", environment "dev" — it must stay distinct
-- from shop/prod (Phase K1).
CREATE TABLE shop.orders (
  order_id BIGINT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  order_ts TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL,
  channel VARCHAR(20),
  currency VARCHAR(3),
  promotion_id INTEGER,
  shipping_amount DECIMAL(10,2),
  tax_amount DECIMAL(10,2),
  gift_wrap BOOLEAN,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE shop.customers (
  customer_id INTEGER PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(32),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  marketing_opt_in BOOLEAN,
  country_code VARCHAR(2)
);
