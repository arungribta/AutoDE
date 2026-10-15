-- Source system 1: e-commerce OLTP ("shop"). Reference problem for the AutoDE eval harness.
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

CREATE TABLE shop.customer_addresses (
  address_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  address_type VARCHAR(20),
  line1 VARCHAR(255),
  city VARCHAR(100),
  postal_code VARCHAR(20),
  country_code VARCHAR(2),
  is_default BOOLEAN
);

CREATE TABLE shop.product_categories (
  category_id INTEGER PRIMARY KEY,
  category_name VARCHAR(100) NOT NULL,
  parent_category_id INTEGER,
  created_at TIMESTAMP
);

CREATE TABLE shop.products (
  product_id INTEGER PRIMARY KEY,
  sku VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  category_id INTEGER,
  brand VARCHAR(100),
  unit_cost DECIMAL(10,2),
  list_price DECIMAL(10,2),
  is_active BOOLEAN,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

CREATE TABLE shop.promotions (
  promotion_id INTEGER PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  description VARCHAR(255),
  discount_pct DECIMAL(5,2),
  starts_at TIMESTAMP,
  ends_at TIMESTAMP
);

CREATE TABLE shop.orders (
  order_id BIGINT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  order_ts TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL, -- PLACED, SHIPPED, DELIVERED, CANCELLED, RETURNED
  channel VARCHAR(20),
  currency VARCHAR(3),
  promotion_id INTEGER,
  shipping_amount DECIMAL(10,2),
  tax_amount DECIMAL(10,2),
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE shop.order_items (
  order_item_id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2),
  created_at TIMESTAMP
);

CREATE TABLE shop.payments (
  payment_id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  payment_method VARCHAR(20),
  amount DECIMAL(10,2) NOT NULL,
  paid_at TIMESTAMP,
  status VARCHAR(20)
);

CREATE TABLE shop.refunds (
  refund_id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  order_item_id BIGINT,
  amount DECIMAL(10,2) NOT NULL,
  reason VARCHAR(100),
  refunded_at TIMESTAMP NOT NULL
);

CREATE TABLE shop.shipments (
  shipment_id INTEGER PRIMARY KEY,
  order_id BIGINT NOT NULL,
  carrier VARCHAR(50),
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  status VARCHAR(20)
);

-- Reference data. crm.ddl has a table with the same fully qualified name (ref.currency_codes)
-- but different columns: the two systems must not collapse into one table (Phase K1 trap).
CREATE TABLE ref.currency_codes (
  code CHAR(3) PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  minor_units INTEGER
);
