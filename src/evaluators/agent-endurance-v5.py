"""Deterministic CLI-only evaluator for Agent Endurance V5 / spec 3.0.0 rev 2.

evaluatorVersion: ae5-hidden-1
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

EVALUATOR_VERSION = "ae5-hidden-1"
SOURCE = os.path.abspath(sys.argv[1])
RESULTS = []


def check(group, name, fn):
    try:
        fn()
        RESULTS.append((group, name, True, ""))
    except Exception as exc:
        prefix = "INTERFACE_MISSING: " if isinstance(exc, (FileNotFoundError, ModuleNotFoundError)) else ""
        RESULTS.append((group, name, False, prefix + type(exc).__name__ + ": " + str(exc)))


def truth(value, message):
    if not value:
        raise AssertionError(message)


def prepare():
    temp = tempfile.mkdtemp(prefix="ae5-hidden-")
    package = os.path.join(SOURCE, "wms")
    if not os.path.isdir(package):
        raise FileNotFoundError("wms package missing")
    shutil.copytree(package, os.path.join(temp, "wms"))
    return temp


def command(root, data, *args, expect=0):
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONHASHSEED": "0",
           "WMS_NOW": "2026-01-02T03:04:05+00:00"}
    proc = subprocess.run([sys.executable, "-m", "wms", "--data", data, *args],
                          cwd=root, env=env, text=True, capture_output=True, timeout=20)
    truth(proc.returncode == expect, "exit %s != %s: %s %s" %
          (proc.returncode, expect, proc.stdout[-300:], proc.stderr[-300:]))
    try:
        payload = json.loads(proc.stdout)
    except Exception as exc:
        raise AssertionError("stdout is not one JSON object: %s" % proc.stdout[:300]) from exc
    truth(isinstance(payload, dict) and payload.get("ok") == (expect == 0), "wrong JSON envelope")
    return payload


def seed(root, data, qty="20"):
    command(root, data, "warehouse", "add", "--id", "w1", "--name", "One")
    command(root, data, "warehouse", "add", "--id", "w2", "--name", "Two")
    command(root, data, "sku", "add", "--sku", "sku", "--name", "Widget", "--price", "12.50")
    command(root, data, "stock", "adjust", "--warehouse", "w1", "--sku", "sku", "--qty", qty)


def isolated(fn):
    root = prepare()
    try:
        return fn(root, os.path.join(root, "data.json"))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def help_check(root, data):
    proc = subprocess.run([sys.executable, "-m", "wms", "--help"], cwd=root,
                          text=True, capture_output=True, timeout=20)
    truth(proc.returncode == 0, "python -m wms --help failed")


def own_tests():
    proc = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"],
                          cwd=SOURCE, env={"PATH": os.environ.get("PATH", ""), "PYTHONHASHSEED": "0"},
                          text=True, capture_output=True, timeout=180)
    truth(proc.returncode == 0, "own unittest suite failed")


def inventory(root, data):
    seed(root, data)
    out = command(root, data, "stock", "show")["result"]["stock"]
    truth(out == sorted(out, key=lambda row: (row["warehouse"], row["sku"])), "stock not sorted")
    row = out[0]
    truth(all(key in row for key in ("on_hand", "reserved", "available")), "stock fields missing")
    command(root, data, "stock", "adjust", "--warehouse", "missing", "--sku", "sku", "--qty", "1", expect=4)


def reservations(root, data):
    seed(root, data, "5")
    before = open(data, "rb").read()
    command(root, data, "order", "create", "--id", "bad", "--warehouse", "w1",
            "--line", "sku:6", expect=3)
    truth(open(data, "rb").read() == before, "failed order changed data file")
    out = command(root, data, "order", "create", "--id", "o", "--warehouse", "w1", "--line", "sku:2")
    truth(out["result"]["status"] == "RESERVED", "order not reserved")
    command(root, data, "order", "ship", "--id", "o")


def transfers(root, data):
    seed(root, data)
    command(root, data, "transfer", "create", "--id", "t", "--from", "w1", "--to", "w2", "--line", "sku:5")
    part = command(root, data, "transfer", "receive", "--id", "t", "--line", "sku:2")
    truth(part["result"]["status"] == "PARTIAL", "partial status missing")
    before = open(data, "rb").read()
    command(root, data, "transfer", "receive", "--id", "t", "--line", "sku:4", expect=3)
    truth(open(data, "rb").read() == before, "over-receive mutated data")


def purchasing(root, data):
    seed(root, data)
    command(root, data, "po", "create", "--id", "p", "--supplier", "s", "--warehouse", "w2", "--line", "sku:3")
    command(root, data, "po", "receive", "--id", "p", "--line", "sku:1")
    closed = command(root, data, "po", "receive", "--id", "p", "--line", "sku:2")
    truth(closed["result"]["status"] == "CLOSED", "PO not closed")
    command(root, data, "po", "receive", "--id", "p", "--line", "sku:1", expect=3)


def returns(root, data):
    seed(root, data)
    command(root, data, "order", "create", "--id", "o", "--warehouse", "w1", "--line", "sku:2")
    command(root, data, "order", "ship", "--id", "o")
    command(root, data, "return", "create", "--id", "r", "--order", "o", "--line", "sku:1")
    refund = command(root, data, "refund", "issue", "--return", "r")
    truth(refund["result"]["amount"] == "12.50", "wrong refund amount")
    command(root, data, "refund", "issue", "--return", "r", expect=3)


def persistence(root, data):
    seed(root, data)
    doc = json.load(open(data, encoding="utf8"))
    truth(doc.get("schema_version") == 1 and set(doc) >= {"checksum", "data"}, "wrong data envelope")
    expected = hashlib.sha256(json.dumps(doc["data"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    truth(doc["checksum"] == expected, "wrong checksum")
    doc["checksum"] = "0" * 64
    open(data, "w", encoding="utf8").write(json.dumps(doc))
    before = open(data, "rb").read()
    command(root, data, "check", expect=5)
    truth(open(data, "rb").read() == before, "integrity failure overwrote file")


def reports(root, data):
    seed(root, data)
    command(root, data, "order", "create", "--id", "o", "--warehouse", "w1", "--line", "sku:2")
    command(root, data, "order", "ship", "--id", "o")
    sales = command(root, data, "report", "sales")["result"]
    truth(all(k in sales for k in ("orders_shipped", "units_sold", "revenue", "refunds", "net_revenue", "by_sku")), "sales fields missing")


check("interface", "package help", lambda: isolated(help_check))
check("interface", "agent unittest suite", own_tests)
check("inventory", "stock and errors", lambda: isolated(inventory))
check("reservations", "atomic reservation and shipping", lambda: isolated(reservations))
check("transfers", "partial receive and rollback", lambda: isolated(transfers))
check("purchasing", "partial and closed purchase order", lambda: isolated(purchasing))
check("returns", "refund amount and duplicate prevention", lambda: isolated(returns))
check("persistence", "checksum and non-mutating rejection", lambda: isolated(persistence))
check("reports", "fixed sales report shape", lambda: isolated(reports))

categories = {}
for group, _, ok, _ in RESULTS:
    item = categories.setdefault(group, {"passed": 0, "total": 0})
    item["total"] += 1
    item["passed"] += int(ok)
print(json.dumps({
    "evaluatorVersion": EVALUATOR_VERSION,
    "passed": sum(int(ok) for _, _, ok, _ in RESULTS),
    "total": len(RESULTS),
    "categories": categories,
    "details": [name + ": " + detail for _, name, ok, detail in RESULTS if not ok],
    "interfaceMissing": sum("INTERFACE_MISSING" in detail for _, _, ok, detail in RESULTS if not ok),
}, sort_keys=True))
