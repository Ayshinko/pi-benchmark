"""Agent Endurance V3 hidden evaluator.

Deterministic, independent verification of the produced Python Mini Warehouse
Management System. This file lives in the benchmark repository (src/evaluators)
and is never copied into the evaluated workspace, so the evaluated agent never
sees these tests or their expectations.

Rules:
- Only the public contract documented in the benchmark prompt is exercised.
- Line payload conventions differ between implementations: the evaluator accepts
  both {sku: qty} mappings and [{"sku": ..., "qty": ...} lists] and remembers the
  shape the implementation accepted, so a chosen-but-documented-elsewhere format
  is not scored as a failure.
- Every mutation check verifies that a rejected operation left state unchanged.
- Output is one JSON object; the run is reproducible (same input -> same output).

evaluatorVersion: ae3-hidden-2
"""
import copy
import hashlib
import importlib
import json
import os
import subprocess
import sys
import tempfile

EVALUATOR_VERSION = "ae3-hidden-2"
ROOT = os.path.abspath(sys.argv[1])
sys.path.insert(0, ROOT)
# IMPORTANT: module-level helper names must never shadow package attribute names
# (a bare `import warehouse` inside a helper name once broke a whole run).
results = []
SHAPE = {}


def check(category, name, fn):
    try:
        fn()
        results.append((category, name, True, ""))
    except Exception as e:  # noqa: BLE001 - reported as a failed check
        results.append((category, name, False, "%s: %s" % (type(e).__name__, e)))


def eq(a, b):
    if a != b:
        raise AssertionError("%r != %r" % (a, b))


def truth(cond, msg):
    if not cond:
        raise AssertionError(msg)


def raises(fn, *args):
    call = fn(*args) if args else fn
    try:
        call()
    except (ValueError, KeyError, TypeError, AssertionError):
        return
    raise AssertionError("operation did not fail as expected")


def payload(shape, lines):
    if lines is None:
        return None
    if shape == "list":
        return [{"sku": k, "qty": v} for k, v in lines.items()]
    return dict(lines)


def call(obj, method, lines=None, *rest):
    """Call obj.method(*rest, lines) with whichever line shape it accepts."""
    errors = []
    shapes = [SHAPE[method]] if method in SHAPE else ["dict", "list"]
    for shape in shapes:
        args = list(rest)
        if lines is not None:
            args.append(payload(shape, lines))
        try:
            out = getattr(obj, method)(*args)
            SHAPE.setdefault(method, shape)
            return out
        except Exception as e:  # noqa: BLE001 - try the next supported shape
            errors.append(e)
    raise errors[-1]


def available(reading):
    """Normalise a single stock reading: number or {'available': n, 'reserved': n}."""
    if isinstance(reading, dict):
        return int(reading.get("available", 0))
    return int(reading)


def total_stock(reading):
    if isinstance(reading, dict):
        return int(reading.get("available", 0)) + int(reading.get("reserved", 0))
    return int(reading)


def doc_state(document):
    """Return the payload of a persisted document, tolerating wrapper layouts."""
    if isinstance(document, dict) and isinstance(document.get("payload"), dict):
        return document["payload"]
    return document


def find_checksum_keys(node, depth=0):
    """Names of dict keys that look like an integrity checksum (any nesting level)."""
    found = []
    if depth > 4:
        return found
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(key, str) and any(token in key.lower() for token in ("checksum", "sha256", "integrity", "hash")):
                found.append(key)
            found.extend(find_checksum_keys(value, depth + 1))
    elif isinstance(node, list):
        for item in node[:6]:
            found.extend(find_checksum_keys(item, depth + 1))
    return found


def mutate_numbers(node, delta=7):
    """Change the first quantity-like integer found in a persisted document."""
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, int) and not isinstance(value, bool) and key.lower() in (
                "available", "qty", "quantity", "count", "reserved", "total", "amount",
            ):
                node[key] = value + delta
                return True
            if mutate_numbers(value, delta):
                return True
        return False
    if isinstance(node, list):
        for item in node:
            if mutate_numbers(item, delta):
                return True
    return False


def system(path=None):
    module = importlib.import_module("warehouse")
    return module.WarehouseSystem(path)


def seeded(path=None):
    s = system(path)
    s.add_warehouse("w1", "One")
    s.add_warehouse("w2", "Two")
    s.add_product("sku", "Widget", "12.50")
    s.stock("w1", "sku", 10)
    return s


def snapshot_of(state):
    try:
        return json.loads(json.dumps(state, sort_keys=True, default=str))
    except Exception:  # noqa: BLE001
        return copy.deepcopy(state)


def unwrap_cli_json(text):
    """Accept both bare payloads and {"ok": ..., "result": ...} envelopes."""
    payload = json.loads(text)
    if isinstance(payload, dict) and "result" in payload and payload.get("ok") is not None:
        return payload["result"]
    return payload


def cli(args, data):
    base = [sys.executable, "-m", "warehouse", "--data", data]
    return subprocess.run(base + [str(a) for a in args], cwd=ROOT, text=True,
                          capture_output=True, timeout=30)


# ---------------------------------------------------------------- contract ---
def contract():
    s = system()
    for name in ("add_warehouse", "add_product", "stock", "inventory", "create_order", "reserve_order",
                 "ship_order", "create_transfer", "ship_transfer", "receive_transfer",
                 "create_purchase_order", "receive_purchase_order", "return_order", "refund_return",
                 "save", "load", "inventory_report", "sales_report"):
        truth(callable(getattr(s, name, None)), "missing method %s" % name)


check("api", "import contract", contract)


# -------------------------------------------------------------- inventory ---
def multi_warehouse():
    s = seeded()
    eq(available(s.inventory("w1", "sku")), 10)
    eq(available(s.inventory("w2", "sku")), 0)


check("inventory", "multi warehouse", multi_warehouse)


def stock_validation():
    s = seeded()
    raises(lambda: s.stock("w1", "sku", -1))
    raises(lambda: s.stock("w3", "sku", 1))
    raises(lambda: s.add_warehouse("w1", "dup"))
    raises(lambda: s.add_product("sku", "dup", "1.00"))


check("inventory", "stock and duplicate validation", stock_validation)


def reports_shape():
    s = seeded()
    call(s, "create_order", {"sku": 2}, "o", "cust")
    call(s, "reserve_order", None, "o", "w1")
    call(s, "ship_order", None, "o")
    for report in (s.inventory_report(), s.sales_report()):
        json.dumps(report)
    eq(s.sales_report(), s.sales_report())
    eq(s.inventory_report(), s.inventory_report())


check("reports", "deterministic JSON-serializable reports", reports_shape)


# ------------------------------------------------------------------ orders ---
def reserve_and_ship():
    s = seeded()
    call(s, "create_order", {"sku": 4}, "o", "cust")
    call(s, "reserve_order", None, "o", "w1")
    eq(available(s.inventory("w1", "sku")), 6)
    call(s, "ship_order", None, "o")
    eq(total_stock(s.inventory("w1", "sku")), 6)


check("orders", "reserve and ship", reserve_and_ship)


def ship_once():
    s = seeded()
    call(s, "create_order", {"sku": 3}, "o", "cust")
    call(s, "reserve_order", None, "o", "w1")
    call(s, "ship_order", None, "o")
    before = snapshot_of([s.inventory("w1", "sku")])
    try:
        call(s, "ship_order", None, "o")
    except (ValueError, KeyError, TypeError):
        pass
    eq(snapshot_of([s.inventory("w1", "sku")]), before)


check("orders", "shipping consumes reserved stock only once", ship_once)


# ----------------------------------------------------------- transactions ---
def atomic_reserve():
    s = seeded()
    s.add_product("x", "X", "1")
    s.stock("w1", "x", 1)
    call(s, "create_order", {"sku": 3, "x": 2}, "o", "cust")
    before = snapshot_of([s.inventory("w1", "sku"), s.inventory("w1", "x"), s.inventory_report()])
    raises(lambda: call(s, "reserve_order", None, "o", "w1"))
    eq(snapshot_of([s.inventory("w1", "sku"), s.inventory("w1", "x"), s.inventory_report()]), before)


check("transactions", "atomic reservation failure", atomic_reserve)


def atomic_transfer():
    s = seeded()
    before = snapshot_of([s.inventory("w1", "sku"), s.inventory("w2", "sku")])
    raises(lambda: call(s, "create_transfer", {"sku": 99}, "t", "w1", "w2"))
    eq(snapshot_of([s.inventory("w1", "sku"), s.inventory("w2", "sku")]), before)


check("transactions", "atomic transfer failure", atomic_transfer)


def atomic_order_rejected_undone():
    s = seeded()
    before = snapshot_of([s.inventory("w1", "sku"), s.inventory_report()])
    raises(lambda: call(s, "create_order", {"sku": -1}, "o", "cust"))
    raises(lambda: call(s, "create_order", {"missing-sku": 1}, "o2", "cust"))
    eq(snapshot_of([s.inventory("w1", "sku"), s.inventory_report()]), before)


check("transactions", "invalid lines rejected without mutation", atomic_order_rejected_undone)


# ------------------------------------------------------------- transfers ---
def partial_receive():
    s = seeded()
    call(s, "create_transfer", {"sku": 6}, "t", "w1", "w2")
    call(s, "ship_transfer", None, "t")
    eq(available(s.inventory("w1", "sku")), 4)
    call(s, "receive_transfer", {"sku": 2}, "t")
    eq(available(s.inventory("w2", "sku")), 2)
    call(s, "receive_transfer", {"sku": 4}, "t")
    eq(available(s.inventory("w2", "sku")), 6)
    before = snapshot_of([s.inventory("w2", "sku")])
    raises(lambda: call(s, "receive_transfer", {"sku": 1}, "t"))
    eq(snapshot_of([s.inventory("w2", "sku")]), before)


check("transfers", "partial receive and bound", partial_receive)


# ------------------------------------------------------------ purchasing ---
def po_receiving():
    s = seeded()
    call(s, "create_purchase_order", {"sku": 5}, "p", "sup", "w2")
    call(s, "receive_purchase_order", {"sku": 2}, "p")
    eq(available(s.inventory("w2", "sku")), 2)
    before = snapshot_of([s.inventory("w2", "sku")])
    raises(lambda: call(s, "receive_purchase_order", {"sku": 4}, "p"))
    eq(snapshot_of([s.inventory("w2", "sku")]), before)


check("purchasing", "receiving constraint", po_receiving)


# --------------------------------------------------------------- returns ---
def duplicate_refund():
    s = seeded()
    call(s, "create_order", {"sku": 2}, "o", "cust")
    call(s, "reserve_order", None, "o", "w1")
    call(s, "ship_order", None, "o")
    call(s, "return_order", {"sku": 1}, "r", "o")
    call(s, "refund_return", None, "r")
    before = snapshot_of([s.inventory("w1", "sku"), s.sales_report()])
    raises(lambda: call(s, "refund_return", None, "r"))
    eq(snapshot_of([s.inventory("w1", "sku"), s.sales_report()]), before)


check("returns", "duplicate refund prevention", duplicate_refund)


def return_bounds():
    s = seeded()
    call(s, "create_order", {"sku": 2}, "o", "cust")
    call(s, "reserve_order", None, "o", "w1")
    call(s, "ship_order", None, "o")
    before = snapshot_of([s.inventory("w1", "sku")])
    raises(lambda: call(s, "return_order", {"sku": 5}, "r", "o"))
    eq(snapshot_of([s.inventory("w1", "sku")]), before)


check("returns", "returns never exceed shipped", return_bounds)


def refund_restocks():
    s = seeded()
    call(s, "create_order", {"sku": 2}, "o", "cust")
    call(s, "reserve_order", None, "o", "w1")
    call(s, "ship_order", None, "o")
    call(s, "return_order", {"sku": 2}, "r", "o")
    call(s, "refund_return", None, "r")
    eq(available(s.inventory("w1", "sku")), 10)


check("returns", "refund restocks once", refund_restocks)


# ----------------------------------------------------------- persistence ---
def persistence_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "db.json")
        s = seeded(p)
        call(s, "create_order", {"sku": 4}, "o", "cust")
        call(s, "reserve_order", None, "o", "w1")
        s.save()
        q = system(p)
        q.load()
        eq(available(q.inventory("w1", "sku")), 6)
        eq(total_stock(q.inventory("w1", "sku")), 10)


check("persistence", "roundtrip preserves reservations", persistence_roundtrip)


def tamper_rejected():
    """Two tamper vectors: a wrong checksum, or changed data with the old checksum.
    A conforming implementation rejects both, without mutating live state."""
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "db.json")
        s = seeded(p)
        call(s, "create_order", {"sku": 2}, "o", "cust")
        call(s, "reserve_order", None, "o", "w1")
        s.save()
        q = system(p)
        q.load()
        with open(p, encoding="utf8") as fh:
            document = json.load(fh)
        checksum_keys = find_checksum_keys(document)
        if checksum_keys:
            document[checksum_keys[0]] = "tampered"
        else:
            truth(mutate_numbers(document), "persisted document has no quantity to tamper with")
        with open(p, "w", encoding="utf8") as fh:
            fh.write(json.dumps(document))
        before = snapshot_of([q.inventory_report()])
        raises(q.load)
        eq(snapshot_of([q.inventory_report()]), before)


check("persistence", "tamper rejection", tamper_rejected)


def atomic_write_no_partial():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "db.json")
        s = seeded(p)
        s.save()
        first = open(p, encoding="utf8").read()
        s.stock("w1", "sku", 5)
        s.save()
        second = open(p, encoding="utf8").read()
        truth(first != second, "save() did not rewrite the file")
        truth(not [n for n in os.listdir(d) if n.endswith((".tmp", ".part", ".json.tmp", ".bak"))],
              "temporary files left behind")
        json.loads(second)


check("persistence", "atomic replacement leaves no temp files", atomic_write_no_partial)


# -------------------------------------------------------------------- cli ---
def cli_cross_process():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "db.json")
        for args in (["add-warehouse", "w1", "One"], ["add-product", "sku", "Widget", "12.50"],
                     ["stock", "w1", "sku", "3"], ["inventory", "w1", "sku"]):
            r = cli(args, p)
            truth(r.returncode == 0, "cli %s failed: %s" % (args, r.stderr))
            unwrap_cli_json(r.stdout)


check("cli", "cross-process JSON CLI", cli_cross_process)


def cli_failure_exit_code():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "db.json")
        r = cli(["inventory", "does-not-exist", "sku"], p)
        truth(r.returncode != 0, "cli should exit non-zero for an unknown warehouse")
        if r.stdout.strip():
            truth(not unwrap_cli_json(r.stdout).get("ok", False) if isinstance(unwrap_cli_json(r.stdout), dict) else False,
                  "cli must not report success on failure")


check("cli", "failure exits non-zero", cli_failure_exit_code)


def cli_persists_state():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "db.json")
        for args in (["add-warehouse", "w1", "One"], ["add-product", "sku", "Widget", "12.50"],
                     ["stock", "w1", "sku", "5"],
                     ["order", "o1", "cust", "sku=2"], ["reserve", "o1", "w1"], ["ship", "o1"]):
            r = cli(args, p)
            truth(r.returncode == 0, "cli %s failed: %s" % (args, r.stderr))
        r = cli(["inventory", "w1", "sku"], p)
        truth(r.returncode == 0, "second process lost state: %s" % r.stderr)
        eq(total_stock(unwrap_cli_json(r.stdout)), 3)


check("cli", "orders work across processes", cli_persists_state)

# ------------------------------------------------------------------ output --
categories = {}
for category, name, ok, detail in results:
    entry = categories.setdefault(category, {"passed": 0, "total": 0})
    entry["total"] += 1
    entry["passed"] += int(ok)

source = open(__file__, "rb").read()
out = {
    "passed": sum(1 for r in results if r[2]),
    "total": len(results),
    "categories": categories,
    "details": ["%s: %s" % (name, detail) for _, name, ok, detail in results if not ok],
    "evaluatorVersion": EVALUATOR_VERSION,
    "evaluatorSha256": hashlib.sha256(source).hexdigest(),
}
print(json.dumps(out, sort_keys=True))
