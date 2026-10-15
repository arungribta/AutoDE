-- Source system 2: CRM / loyalty ("crm"). Reference problem for the AutoDE eval harness.
-- Note: crm.customers deliberately shares a table name with shop.customers, as real estates often do.
CREATE TABLE crm.customers (
  cust_no VARCHAR(20) PRIMARY KEY,
  shop_customer_id INTEGER,
  full_name VARCHAR(200),
  email VARCHAR(255),
  phone VARCHAR(32),
  segment_code VARCHAR(10),
  lifecycle_stage VARCHAR(20),
  created_date DATE,
  last_modified TIMESTAMP
);

CREATE TABLE crm.accounts (
  account_id VARCHAR(20) PRIMARY KEY,
  cust_no VARCHAR(20) NOT NULL,
  account_type VARCHAR(20),
  region VARCHAR(50),
  owner_rep VARCHAR(100),
  opened_date DATE,
  closed_date DATE
);

CREATE TABLE crm.segments (
  segment_code VARCHAR(10) PRIMARY KEY,
  segment_name VARCHAR(100),
  description VARCHAR(255),
  min_lifetime_value DECIMAL(12,2)
);

CREATE TABLE crm.loyalty_members (
  member_id VARCHAR(20) PRIMARY KEY,
  cust_no VARCHAR(20) NOT NULL,
  tier VARCHAR(20),
  points_balance INTEGER,
  enrolled_at TIMESTAMP,
  status VARCHAR(20)
);

CREATE TABLE crm.loyalty_transactions (
  txn_id BIGINT PRIMARY KEY,
  member_id VARCHAR(20) NOT NULL,
  order_ref BIGINT,
  points INTEGER,
  txn_type VARCHAR(20),
  txn_ts TIMESTAMP
);

CREATE TABLE crm.campaigns (
  campaign_id INTEGER PRIMARY KEY,
  campaign_name VARCHAR(200),
  channel VARCHAR(20),
  start_date DATE,
  end_date DATE,
  budget DECIMAL(12,2)
);

CREATE TABLE crm.campaign_responses (
  response_id BIGINT PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  cust_no VARCHAR(20) NOT NULL,
  responded_at TIMESTAMP,
  response_type VARCHAR(20)
);

CREATE TABLE crm.support_tickets (
  ticket_id BIGINT PRIMARY KEY,
  cust_no VARCHAR(20) NOT NULL,
  opened_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  category VARCHAR(50),
  priority VARCHAR(10),
  csat_score INTEGER
);
