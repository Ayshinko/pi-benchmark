"""Reference Agent Endurance V3 CLI: `python -m warehouse --data PATH <subcommand>`."""
from __future__ import annotations

import argparse
import json
import sys

from . import WarehouseSystem


def _parse_line(text: str) -> tuple[str, int]:
    sku, _, qty = text.partition("=")
    if not qty:
        raise argparse.ArgumentTypeError("line must look like sku=3")
    return sku, int(qty)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="warehouse", description="Mini warehouse management system")
    parser.add_argument("--data", required=True, help="path to the persisted JSON document")
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, help_text):
        return sub.add_parser(name, help=help_text)

    p = add("add-warehouse", "register a warehouse")
    p.add_argument("warehouse_id")
    p.add_argument("name")
    p = add("add-product", "register a product")
    p.add_argument("sku")
    p.add_argument("name")
    p.add_argument("price")
    p = add("stock", "add stock to a warehouse")
    p.add_argument("warehouse_id")
    p.add_argument("sku")
    p.add_argument("qty", type=int)
    p = add("inventory", "print one stock reading")
    p.add_argument("warehouse_id")
    p.add_argument("sku")
    p = add("order", "create a customer order (lines as sku=qty)")
    p.add_argument("order_id")
    p.add_argument("customer_id")
    p.add_argument("lines", nargs="+", type=_parse_line)
    p = add("reserve", "reserve stock for an order")
    p.add_argument("order_id")
    p.add_argument("warehouse_id")
    p = add("ship", "ship a reserved order")
    p.add_argument("order_id")
    p = add("transfer", "create a warehouse transfer")
    p.add_argument("transfer_id")
    p.add_argument("source")
    p.add_argument("destination")
    p.add_argument("lines", nargs="+", type=_parse_line)
    p = add("ship-transfer", "ship a transfer out of the source warehouse")
    p.add_argument("transfer_id")
    p = add("receive-transfer", "receive (possibly partial) quantities for a transfer")
    p.add_argument("transfer_id")
    p.add_argument("quantities", nargs="+", type=_parse_line)
    p = add("purchase-order", "create a purchase order")
    p.add_argument("po_id")
    p.add_argument("supplier_id")
    p.add_argument("warehouse_id")
    p.add_argument("lines", nargs="+", type=_parse_line)
    p = add("receive-purchase", "receive quantities for a purchase order")
    p.add_argument("po_id")
    p.add_argument("quantities", nargs="+", type=_parse_line)
    p = add("return", "register a return for a shipped order")
    p.add_argument("return_id")
    p.add_argument("order_id")
    p.add_argument("lines", nargs="+", type=_parse_line)
    p = add("refund", "refund a registered return once")
    p.add_argument("return_id")
    p = add("reports", "print inventory and sales reports")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    system = WarehouseSystem(args.data)
    try:
        import os

        if os.path.exists(args.data):
            system.load()
        command = args.command
        if command == "add-warehouse":
            result = system.add_warehouse(args.warehouse_id, args.name)
        elif command == "add-product":
            result = system.add_product(args.sku, args.name, args.price)
        elif command == "stock":
            result = system.stock(args.warehouse_id, args.sku, args.qty)
        elif command == "inventory":
            result = system.inventory(args.warehouse_id, args.sku)
        elif command == "order":
            result = system.create_order(args.order_id, args.customer_id, dict(args.lines))
        elif command == "reserve":
            result = system.reserve_order(args.order_id, args.warehouse_id)
        elif command == "ship":
            result = system.ship_order(args.order_id)
        elif command == "transfer":
            result = system.create_transfer(args.transfer_id, args.source, args.destination, dict(args.lines))
        elif command == "ship-transfer":
            result = system.ship_transfer(args.transfer_id)
        elif command == "receive-transfer":
            result = system.receive_transfer(args.transfer_id, dict(args.quantities))
        elif command == "purchase-order":
            result = system.create_purchase_order(args.po_id, args.supplier_id, args.warehouse_id, dict(args.lines))
        elif command == "receive-purchase":
            result = system.receive_purchase_order(args.po_id, dict(args.quantities))
        elif command == "return":
            result = system.return_order(args.return_id, args.order_id, dict(args.lines))
        elif command == "refund":
            result = system.refund_return(args.return_id)
        elif command == "reports":
            result = {"inventory": system.inventory_report(), "sales": system.sales_report()}
        else:  # pragma: no cover - argparse enforces the subcommand list
            raise SystemExit(2)
        if command != "reports":
            if os.path.exists(args.data) or command not in ("inventory",):
                system.save()
        print(json.dumps({"ok": True, "command": command, "result": result}, sort_keys=True, default=str))
        return 0
    except Exception as error:  # noqa: BLE001 - CLI reports a concise failure
        print(json.dumps({"ok": False, "command": args.command, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
