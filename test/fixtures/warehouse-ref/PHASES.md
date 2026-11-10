# Agent Endurance V3 phase evidence (reference fixture)

1. Architecture and implementation plan — `docs/architecture.md` describes the package layout, invariants and persistence format.
2. Multi-warehouse inventory management — `warehouse/__init__.py` keeps per-(warehouse, sku) available/reserved buckets; `tests`-equivalent checks in `__init__.py`.
3. Customer orders and atomic reservations — `create_order`, `reserve_order`, `ship_order`; validation happens before any mutation.
4. Warehouse transfers and partial receiving — `create_transfer`, `ship_transfer`, `receive_transfer` bound by remaining quantities.
5. Purchase orders and supplier receiving — `create_purchase_order`, `receive_purchase_order` bound by ordered quantities.
6. Returns, refunds and duplicate prevention — `return_order`, `refund_return` refuse a second refund and quantities above shipped.
7. JSON persistence, atomic writes and integrity checks — `save()` writes a temp file then `os.replace`; `load()` verifies the sha256 checksum before swapping state.
8. Inventory reporting and sales analytics — `inventory_report()` and `sales_report()` are deterministic and JSON-serialisable.
9. Complete argparse CLI — `python -m warehouse --data PATH <subcommand>` prints JSON on success and exits non-zero on failure.
10. Unit tests — the fixture is exercised by the hidden evaluator; a production agent must add >= 120 tests here.
11. Refactoring and full regression testing — helpers `_lines`, `_Record`, `_bucket` centralise validation.
12. End-to-end integration scenarios — hidden evaluator runs order/transfer/PO/return/persistence/CLI flows across separate processes.
