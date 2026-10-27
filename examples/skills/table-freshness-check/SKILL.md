---
name: table-freshness-check
description: Checks how fresh the team's warehouse tables are - reads the latest load timestamp of each table in a list and reports the ones older than their freshness target. Use when asked whether data is up to date or before a reconciliation.
license: MIT
allowed-tools: Read, Bash(python:*), Bash(snow:*)
---

# Table freshness check

An example **procedure skill**: an agent carries it out with tools. It runs a script
and a CLI, so AutoDE won't publish it until a person has reviewed it, and where AutoDE
runs it each command is approved.

## What you need

- The Snowflake CLI (`snow`) with a connection named in `freshness.yaml`.
- Python 3.10 or later.

## Steps

1. Read `freshness.yaml` in the workspace. It lists tables and their targets:

   ```yaml
   connection: analytics_ro
   tables:
     - name: ANALYTICS.MARTS.FCT_ORDERS
       column: LOADED_AT
       max_age_hours: 24
   ```

2. Run the check:

   ```bash
   python scripts/check_freshness.py freshness.yaml
   ```

   The script runs one read-only query per table through
   `snow sql --connection <connection> --format json -q "SELECT MAX(<column>) ..."`
   and prints a JSON report.

3. Report the tables older than their target first, with their age, then the rest.
   Say which tables could not be read and why. Don't change anything.
