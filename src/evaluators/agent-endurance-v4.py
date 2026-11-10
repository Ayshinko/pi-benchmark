"""Agent Endurance V4 evaluator.

V4 preserves the broad V3 hidden suite and adds strict checks for the now-explicit
public data shapes. It is a separate file and identity, so V3 history is untouched.

evaluatorVersion: ae4-hidden-1
"""
import importlib
import json
import os
import subprocess
import sys

EVALUATOR_VERSION = "ae4-hidden-1"
ROOT = os.path.abspath(sys.argv[1])
V3 = os.path.join(os.path.dirname(__file__), "agent-endurance-v3.py")
sys.path.insert(0, ROOT)


def run_v3():
    proc = subprocess.run(
        [sys.executable, V3, ROOT], text=True, capture_output=True, timeout=180
    )
    if proc.returncode != 0:
        raise RuntimeError("base evaluator failed: %s" % proc.stderr[:200])
    return json.loads(proc.stdout)


def strict_inventory():
    module = importlib.import_module("warehouse")
    state = module.WarehouseSystem()
    state.add_warehouse("w1", "One")
    state.add_product("sku", "Widget", "12.50")
    state.stock("w1", "sku", 10)
    value = state.inventory("w1", "sku")
    if type(value) is not int or value != 10:
        raise AssertionError("inventory() must return available quantity as int")


def strict_mapping_lines():
    module = importlib.import_module("warehouse")
    state = module.WarehouseSystem()
    state.add_warehouse("w1", "One")
    state.add_warehouse("w2", "Two")
    state.add_product("sku", "Widget", "12.50")
    state.stock("w1", "sku", 20)
    state.create_order("o", "customer", {"sku": 2})
    state.reserve_order("o", "w1")
    state.ship_order("o")
    state.create_transfer("t", "w1", "w2", {"sku": 3})
    state.ship_transfer("t")
    state.receive_transfer("t", {"sku": 1})
    state.create_purchase_order("p", "supplier", "w2", {"sku": 4})
    state.receive_purchase_order("p", {"sku": 2})
    state.return_order("r", "o", {"sku": 1})


def main():
    try:
        base = run_v3()
    except Exception as exc:
        base = {"passed": 0, "total": 1, "categories": {}, "details": [str(exc)]}
    checks = []
    for name, fn in (("inventory returns int", strict_inventory),
                     ("line and quantity arguments accept mappings", strict_mapping_lines)):
        try:
            fn()
            checks.append((name, True, ""))
        except Exception as exc:
            checks.append((name, False, "%s: %s" % (type(exc).__name__, exc)))
    categories = dict(base.get("categories", {}))
    categories["v4-contract"] = {
        "passed": sum(1 for _, ok, _ in checks if ok), "total": len(checks)
    }
    out = {
        "evaluatorVersion": EVALUATOR_VERSION,
        "passed": int(base.get("passed", 0)) + categories["v4-contract"]["passed"],
        "total": int(base.get("total", 0)) + len(checks),
        "categories": categories,
        "details": list(base.get("details", [])) + [
            "%s: %s" % (name, detail) for name, ok, detail in checks if not ok
        ],
    }
    print(json.dumps(out, sort_keys=True))


if __name__ == "__main__":
    main()
