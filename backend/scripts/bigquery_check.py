"""Live check of the BigQuery data source path: federation from this machine's AWS
identity, listing, the SQL guardrails, a dry run and one capped query.

    uv run python scripts/bigquery_check.py [project.dataset.table]

Needs GCP_WIF_AUDIENCE, GCP_SERVICE_ACCOUNT and BIGQUERY_PROJECT in backend/.env (see
docs/bigquery_setup.md). Reads only; a query scans at most BIGQUERY_MAX_BYTES.
"""

import sys

from agentic_platform import datasources as ds
from agentic_platform.config import BIGQUERY_PROJECT, GCP_SERVICE_ACCOUNT
from agentic_platform.errors import QueryRefusedError


def main() -> None:
    table = sys.argv[1] if len(sys.argv) > 1 else f"{BIGQUERY_PROJECT}.mydata.trips"
    client = ds.BigQueryClient(BIGQUERY_PROJECT, GCP_SERVICE_ACCOUNT)
    check = ds.check_connection(client, BIGQUERY_PROJECT)
    for step in check["steps"]:
        print("ok  " if step["ok"] else "FAIL", step["step"], step.get("error", ""))
    if not check["ok"]:
        raise SystemExit(1)
    print("datasets:", check["datasets"])

    meta = client.table(table)
    source = ds.DataSourceConfig(
        id="check", name="check", billing_project=BIGQUERY_PROJECT, service_account=GCP_SERVICE_ACCOUNT,
        tables=[ds.AllowedTable(id=table, location=meta.get("location", "US"))],
    )
    context = ds.DataContext(lambda: [source], lambda s: client, labels={"agentic_check": "1"})
    print(context.schema()[:600], "…\n")
    try:
        context.query(f"DELETE FROM `{table}` WHERE TRUE")
        raise SystemExit("a DELETE was not refused")
    except QueryRefusedError as e:
        print("write refused before reaching Google:", e)
    columns = [f["name"] for f in meta["schema"]["fields"]][:2]
    sql = f"SELECT {columns[0]}, COUNT(*) AS n FROM `{table}` GROUP BY 1 ORDER BY n DESC LIMIT 5"
    result = context.query(sql)
    print(ds.format_result(result))
    print(f"billed {result.bytes_billed:,} bytes")


if __name__ == "__main__":
    main()
