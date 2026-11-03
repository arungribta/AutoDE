-- Lending fixture (ONT1): LOANSYS, a legacy loan origination and servicing system. Cryptic names, as legacy
-- estates have; its own word for a credit facility is "deal". docs/specs/context-layer.md §6.8.
CREATE TABLE loansys.deal_mstr (
  deal_id VARCHAR(20) PRIMARY KEY,
  brwr_id VARCHAR(20) NOT NULL,
  commit_amt DECIMAL(18,2),
  int_rate DECIMAL(9,6),
  orig_dt DATE,
  mat_dt DATE,
  deal_stat VARCHAR(10)
);

CREATE TABLE loansys.brwr (
  brwr_id VARCHAR(20) PRIMARY KEY,
  brwr_nm VARCHAR(200),
  natl_id VARCHAR(30),
  dob DATE,
  addr_id VARCHAR(20)
);

CREATE TABLE loansys.loan_appl (
  appl_id VARCHAR(20) PRIMARY KEY,
  brwr_id VARCHAR(20) NOT NULL,
  appl_dt DATE NOT NULL,
  req_amt DECIMAL(18,2),
  decision_cd VARCHAR(10)
);

CREATE TABLE loansys.collat (
  collat_id VARCHAR(20) PRIMARY KEY,
  deal_id VARCHAR(20) NOT NULL,
  collat_typ VARCHAR(20),
  collat_val DECIMAL(18,2),
  val_dt DATE
);

CREATE TABLE loansys.pmt (
  pmt_id VARCHAR(20) PRIMARY KEY,
  deal_id VARCHAR(20) NOT NULL,
  pmt_amt DECIMAL(18,2),
  pmt_dt DATE
);

CREATE TABLE loansys.guar (
  guar_id VARCHAR(20) PRIMARY KEY,
  deal_id VARCHAR(20) NOT NULL,
  guarantor_nm VARCHAR(200)
);

CREATE TABLE loansys.cust_acct (
  acct_no VARCHAR(20) PRIMARY KEY,
  brwr_id VARCHAR(20),
  open_dt DATE
);
