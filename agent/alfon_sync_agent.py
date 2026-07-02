"""
alfon_sync_agent.py
-------------------
Local agent: reads Access .accdb → exports CSV → sends to donor server.
The server stores the upload as "pending" — a human must approve it at:
  https://your-server.com/sync.html

Requirements:
  pip install pyodbc requests

Or without pyodbc (read directly from exported CSV):
  python alfon_sync_agent.py --csv path/to/alfon.csv

Windows ODBC driver for Access:
  Download "Microsoft Access Database Engine 2016 Redistributable" (64-bit)
  from https://www.microsoft.com/en-us/download/details.aspx?id=54920
"""

import sys
import os
import csv
import io
import json
import logging
import argparse
from datetime import datetime

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
# Edit these values before running:

ACCESS_FILE = r"\\SERVER\Share\alfon.accdb"   # UNC or local path to .accdb
TABLE_NAME  = "שמות"                          # Table name in Access (adjust!)
SERVER_URL  = "https://your-server.com"       # Your VPS address (no trailing /)
API_KEY     = "REPLACE_WITH_ALFON_SYNC_KEY"   # Must match ALFON_SYNC_KEY in .env

# Optional: column name overrides (if your Access column names differ)
COL_MAP = {
    "מספר סידורי": "מספר סידורי",
    "שם פרטי":    "שם פרטי",
    "שם משפחה":   "שם משפחה",
    "שם אב":      "שם אב",
    "קהילה":      "קהילה",
    "רחוב":       "רחוב",
    "מספר בית":   "מספר בית",
    "דירה":       "דירה",
    "כניסה":      "כניסה",
    "ישוב":       "ישוב",
    "שכונה":      "שכונה",
    "פלאפון א":   "פלאפון א",
    "פלאפון ב":   "פלאפון ב",
    "טלפון ביתי": "טלפון ביתי",
    "פלאפון נוסף":"פלאפון נוסף",
}

# ─── END CONFIGURATION ────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("alfon_sync.log", encoding="utf-8"),
    ]
)
log = logging.getLogger(__name__)


def read_from_access(accdb_path, table_name):
    """Read all rows from an Access table using pyodbc."""
    try:
        import pyodbc
    except ImportError:
        log.error("pyodbc not installed. Run: pip install pyodbc")
        sys.exit(1)

    conn_str = (
        r"Driver={Microsoft Access Driver (*.mdb, *.accdb)};"
        r"Dbq=" + accdb_path + ";"
    )
    log.info(f"Connecting to Access: {accdb_path}")
    try:
        conn = pyodbc.connect(conn_str)
    except Exception as e:
        log.error(f"Cannot open Access file: {e}")
        sys.exit(1)

    cursor = conn.cursor()

    # Build SELECT with mapped column names
    select_cols = ", ".join(f"[{v}]" for v in COL_MAP.values())
    query = f"SELECT {select_cols} FROM [{table_name}]"

    try:
        cursor.execute(query)
    except Exception as e:
        # Try to list available tables to help user configure
        log.error(f"Query failed: {e}")
        try:
            tables = [t.table_name for t in cursor.tables(tableType="TABLE")]
            log.info(f"Available tables in Access: {tables}")
        except Exception:
            pass
        conn.close()
        sys.exit(1)

    headers = [desc[0] for desc in cursor.description]
    rows = []
    for row in cursor.fetchall():
        rows.append([str(v).strip() if v is not None else "" for v in row])

    conn.close()
    log.info(f"Read {len(rows)} rows from table '{table_name}'")
    return headers, rows


def read_from_csv(csv_path):
    """Read from an already-exported CSV file (UTF-8 with BOM)."""
    log.info(f"Reading from CSV: {csv_path}")
    with open(csv_path, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader)
        rows = [list(row) for row in reader]
    log.info(f"Read {len(rows)} rows from CSV")
    return headers, rows


def to_csv_string(headers, rows):
    """Serialize headers+rows to a CSV string (UTF-8 with BOM for Hebrew)."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return "﻿" + buf.getvalue()   # prepend BOM


def send_to_server(csv_content, filename, server_url, api_key):
    """POST CSV to /api/sync/alfon-auto. Returns server JSON response."""
    try:
        import requests
    except ImportError:
        log.error("requests not installed. Run: pip install requests")
        sys.exit(1)

    url = server_url.rstrip("/") + "/api/sync/alfon-auto"
    payload = json.dumps({"content": csv_content, "filename": filename},
                         ensure_ascii=False)

    log.info(f"Sending to {url} ...")
    try:
        resp = requests.post(
            url,
            data=payload.encode("utf-8"),
            headers={
                "Content-Type":  "application/json; charset=utf-8",
                "X-Alfon-Key":   api_key,
            },
            timeout=60,
            verify=True,
        )
    except requests.exceptions.SSLError:
        log.warning("SSL verification failed — retrying without verify (insecure!)")
        resp = requests.post(
            url,
            data=payload.encode("utf-8"),
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "X-Alfon-Key":  api_key,
            },
            timeout=60,
            verify=False,
        )

    if resp.status_code == 401:
        log.error("Server rejected API key — check ALFON_SYNC_KEY in .env and config in this script")
        sys.exit(1)
    if resp.status_code != 200:
        log.error(f"Server error {resp.status_code}: {resp.text[:300]}")
        sys.exit(1)

    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="Alfon sync agent")
    parser.add_argument("--csv",   help="Path to already-exported CSV (skip Access)")
    parser.add_argument("--accdb", help="Path to .accdb file (override ACCESS_FILE)")
    parser.add_argument("--table", help="Table name (override TABLE_NAME)")
    parser.add_argument("--url",   help="Server URL (override SERVER_URL)")
    parser.add_argument("--key",   help="API key (override API_KEY)")
    args = parser.parse_args()

    accdb_path  = args.accdb  or ACCESS_FILE
    table_name  = args.table  or TABLE_NAME
    server_url  = args.url    or SERVER_URL
    api_key     = args.key    or API_KEY

    if api_key == "REPLACE_WITH_ALFON_SYNC_KEY":
        log.error("API_KEY not configured in script. Edit alfon_sync_agent.py")
        sys.exit(1)
    if server_url == "https://your-server.com":
        log.error("SERVER_URL not configured in script. Edit alfon_sync_agent.py")
        sys.exit(1)

    if args.csv:
        headers, rows = read_from_csv(args.csv)
    else:
        headers, rows = read_from_access(accdb_path, table_name)

    csv_content = to_csv_string(headers, rows)
    filename = f"alfon_auto_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

    result = send_to_server(csv_content, filename, server_url, api_key)

    counts = result.get("counts", {})
    log.info(
        f"Upload accepted. pendingId={result.get('pendingId')} | "
        f"new={counts.get('create',0)} update={counts.get('update',0)} "
        f"unchanged={counts.get('unchanged',0)} skip={counts.get('skip',0)}"
    )
    log.info(f"Go to {server_url}/sync.html to review and approve.")


if __name__ == "__main__":
    main()
