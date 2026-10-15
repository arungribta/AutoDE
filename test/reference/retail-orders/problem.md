# Reference business problem: retail orders — net revenue and retention

**Business problem.** The retail team needs daily **net revenue** and **90-day customer retention** reporting in **Snowflake**, built with **dbt** on a **dimensional model**. Data comes from two existing systems:

- **shop** — the e-commerce OLTP database (orders, order lines, payments, refunds, products, customers).
- **crm** — the CRM and loyalty platform (CRM customer master, loyalty members and transactions, campaigns, support tickets).

**Target.** Snowflake database `ANALYTICS`, schemas `STAGING` and `MARTS`; dbt; dimensional modelling; `snake_case` naming.

**Expected outputs.**
- `fct_order_lines` and `fct_daily_revenue` (net revenue per day and channel).
- `dim_customer`: SCD type 2 on segment and lifecycle stage, joining shop and CRM customers.
- `dim_product`, `dim_date`.
- A retention model: a customer is retained if they place another non-cancelled order within 90 days of a previous one.
- Customer email and phone masked in every analytics layer.

This is the problem statement a data engineer would type into AutoDE. The scripted conversation in `chat-script.yaml` supplies the details, and five traps, the way a real engineer would.
