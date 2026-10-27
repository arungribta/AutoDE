"""Reports the freshness of the tables listed in a freshness.yaml (an AutoDE example skill).

Read-only: one SELECT MAX(<column>) per table through the Snowflake CLI.
"""
import datetime
import json
import re
import subprocess
import sys

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$")


def load(path):
    # A tiny reader for the documented shape, so the example needs no packages.
    cfg, tables, cur = {}, [], None
    for raw in open(path, encoding="utf-8"):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        key, _, value = line.strip().lstrip("- ").partition(":")
        value = value.strip()
        if line.lstrip().startswith("- "):
            cur = {}
            tables.append(cur)
        if key == "connection":
            cfg["connection"] = value
        elif key in ("name", "column", "max_age_hours") and cur is not None:
            cur[key] = value
    cfg["tables"] = tables
    return cfg


def latest(connection, table, column):
    if not IDENT.match(table) or not IDENT.match(column):
        raise ValueError(f"not a plain identifier: {table}.{column}")
    out = subprocess.run(
        ["snow", "sql", "--connection", connection, "--format", "json", "-q", f"SELECT MAX({column}) AS LATEST FROM {table}"],
        capture_output=True, text=True, timeout=120, check=True,
    ).stdout
    rows = json.loads(out)
    value = rows[0]["LATEST"] if rows else None
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None


def main(path):
    cfg = load(path)
    now = datetime.datetime.now(datetime.timezone.utc)
    report = []
    for t in cfg["tables"]:
        try:
            at = latest(cfg["connection"], t["name"], t["column"])
            if at and at.tzinfo is None:
                at = at.replace(tzinfo=datetime.timezone.utc)
            age = (now - at).total_seconds() / 3600 if at else None
            report.append({"table": t["name"], "latest": at.isoformat() if at else None, "age_hours": round(age, 1) if age is not None else None,
                           "stale": age is None or age > float(t["max_age_hours"])})
        except Exception as err:  # report and carry on with the next table
            report.append({"table": t.get("name"), "error": str(err)})
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "freshness.yaml")
