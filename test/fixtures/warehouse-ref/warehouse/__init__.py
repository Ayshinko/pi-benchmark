"""Reference implementation of the Agent Endurance V3 public contract.

This fixture is NOT the hidden evaluator (it lives in test/fixtures, outside any
evaluated workspace) and it is never visible to the evaluated agent. It exists so
the hidden evaluator can be validated: a known-good implementation must pass every
hidden check, which guards the benchmark against a broken evaluator.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from decimal import Decimal


def _lines(lines):
    """Normalise line payloads: {sku: qty} or [{"sku","qty"}, ...]."""
    if lines is None:
        return {}
    if isinstance(lines, dict):
        items = list(lines.items())
    else:
        items = [(entry["sku"], entry["qty"]) for entry in lines]
    normalised = {}
    for sku, qty in items:
        if not isinstance(qty, int) or isinstance(qty, bool):
            raise ValueError("quantity must be an integer")
        if qty < 0:
            raise ValueError("quantity must be non-negative")
        normalised[sku] = normalised.get(sku, 0) + qty
    return normalised


class _Record:
    def __init__(self, lines, **fields):
        self.lines = dict(lines)
        self.fields = fields
        self.state = "open"

    def as_dict(self):
        return {"lines": self.lines, "state": self.state, **self.fields}


class WarehouseSystem:
    def __init__(self, data_path=None):
        self.data_path = data_path
        self.warehouses = {}
        self.products = {}
        self._stock = {}
        self.orders = {}
        self.transfers = {}
        self.purchase_orders = {}
        self.returns = {}
        self.movements = []

    # ------------------------------------------------------------- setup ---
    def add_warehouse(self, warehouse_id, name):
        if warehouse_id in self.warehouses:
            raise ValueError(f"duplicate warehouse {warehouse_id}")
        self.warehouses[warehouse_id] = {"id": warehouse_id, "name": name}

    def add_product(self, sku, name, price):
        if sku in self.products:
            raise ValueError(f"duplicate product {sku}")
        self.products[sku] = {"sku": sku, "name": name, "price": str(Decimal(str(price)))}

    def _warehouse(self, warehouse_id):
        if warehouse_id not in self.warehouses:
            raise ValueError(f"unknown warehouse {warehouse_id}")
        return warehouse_id

    def _product(self, sku):
        if sku not in self.products:
            raise ValueError(f"unknown product {sku}")
        return sku

    def _bucket(self, warehouse_id, sku):
        self._warehouse(warehouse_id)
        self._product(sku)
        return self._stock.setdefault((warehouse_id, sku), {"available": 0, "reserved": 0})

    # ------------------------------------------------------------ stock ---
    def stock_at(self, warehouse_id, sku):
        return self._bucket(warehouse_id, sku)

    def stock(self, warehouse_id, sku, qty):
        if not isinstance(qty, int) or isinstance(qty, bool) or qty < 0:
            raise ValueError("quantity must be a non-negative integer")
        bucket = self._bucket(warehouse_id, sku)
        bucket["available"] += qty
        return bucket["available"]

    def inventory(self, warehouse_id, sku):
        return dict(self._bucket(warehouse_id, sku))

    # ----------------------------------------------------------- orders ---
    def _unique(self, table, kind, record_id):
        if record_id in table:
            raise ValueError(f"duplicate {kind} {record_id}")
        return record_id

    def create_order(self, order_id, customer_id, lines):
        payload = _lines(lines)
        if not payload:
            raise ValueError("order requires lines")
        for sku in payload:
            self._product(sku)
        self._unique(self.orders, "order", order_id)
        self.orders[order_id] = _Record(payload, customer_id=customer_id, warehouse=None, shipped={})

    def reserve_order(self, order_id, warehouse_id):
        order = self.orders.get(order_id)
        if order is None:
            raise ValueError(f"unknown order {order_id}")
        if order.state != "open":
            raise ValueError("order is not open")
        self._warehouse(warehouse_id)
        # validate first so a failure leaves every quantity unchanged
        for sku, qty in order.lines.items():
            self._product(sku)
            bucket = self._bucket(warehouse_id, sku)
            if bucket["available"] < qty:
                raise ValueError(f"insufficient stock for {sku}")
        for sku, qty in order.lines.items():
            bucket = self._bucket(warehouse_id, sku)
            bucket["available"] -= qty
            bucket["reserved"] += qty
        order.fields["warehouse"] = warehouse_id
        order.state = "reserved"
        self.movements.append({"kind": "reserve", "order": order_id, "warehouse": warehouse_id, "lines": order.lines})

    def ship_order(self, order_id):
        order = self.orders.get(order_id)
        if order is None:
            raise ValueError(f"unknown order {order_id}")
        if order.state != "reserved":
            raise ValueError("order is not reserved")
        warehouse_id = order.fields["warehouse"]
        for sku, qty in order.lines.items():
            bucket = self._bucket(warehouse_id, sku)
            bucket["reserved"] -= qty
        order.fields["shipped"] = dict(order.lines)
        order.state = "shipped"
        self.movements.append({"kind": "ship", "order": order_id, "warehouse": warehouse_id, "lines": order.lines})

    # --------------------------------------------------------- transfers ---
    def create_transfer(self, transfer_id, source, destination, lines):
        payload = _lines(lines)
        self._warehouse(source)
        self._warehouse(destination)
        for sku, qty in payload.items():
            self._product(sku)
            if self._bucket(source, sku)["available"] < qty:
                raise ValueError(f"insufficient stock for {sku}")
        self._unique(self.transfers, "transfer", transfer_id)
        self.transfers[transfer_id] = _Record(payload, source=source, destination=destination, remaining=dict(payload), received={})

    def ship_transfer(self, transfer_id):
        transfer = self.transfers.get(transfer_id)
        if transfer is None:
            raise ValueError(f"unknown transfer {transfer_id}")
        if transfer.state != "open":
            raise ValueError("transfer is not open")
        for sku, qty in transfer.lines.items():
            bucket = self._bucket(transfer.fields["source"], sku)
            bucket["available"] -= qty
        transfer.state = "shipped"
        self.movements.append({"kind": "transfer_ship", "transfer": transfer_id, "lines": transfer.lines})

    def receive_transfer(self, transfer_id, quantities):
        transfer = self.transfers.get(transfer_id)
        if transfer is None:
            raise ValueError(f"unknown transfer {transfer_id}")
        if transfer.state not in ("shipped", "receiving"):
            raise ValueError("transfer is not shipped")
        payload = _lines(quantities)
        remaining = transfer.fields["remaining"]
        for sku, qty in payload.items():
            if qty > remaining.get(sku, 0):
                raise ValueError(f"cannot receive more than shipped for {sku}")
        for sku, qty in payload.items():
            remaining[sku] -= qty
            bucket = self._bucket(transfer.fields["destination"], sku)
            bucket["available"] += qty
            transfer.fields["received"][sku] = transfer.fields["received"].get(sku, 0) + qty
        transfer.state = "shipped" if any(remaining.values()) else "received"
        self.movements.append({"kind": "transfer_receive", "transfer": transfer_id, "lines": payload})

    # --------------------------------------------------------- purchasing ---
    def create_purchase_order(self, po_id, supplier_id, warehouse_id, lines):
        payload = _lines(lines)
        self._warehouse(warehouse_id)
        for sku in payload:
            self._product(sku)
        self._unique(self.purchase_orders, "purchase order", po_id)
        self.purchase_orders[po_id] = _Record(payload, supplier_id=supplier_id, warehouse=warehouse_id, remaining=dict(payload))

    def receive_purchase_order(self, po_id, quantities):
        order = self.purchase_orders.get(po_id)
        if order is None:
            raise ValueError(f"unknown purchase order {po_id}")
        payload = _lines(quantities)
        remaining = order.fields["remaining"]
        for sku, qty in payload.items():
            if qty > remaining.get(sku, 0):
                raise ValueError(f"cannot receive more than ordered for {sku}")
        for sku, qty in payload.items():
            remaining[sku] -= qty
            bucket = self._bucket(order.fields["warehouse"], sku)
            bucket["available"] += qty
        order.state = "open" if any(remaining.values()) else "received"
        self.movements.append({"kind": "purchase_receive", "po": po_id, "lines": payload})

    # -------------------------------------------------------------- returns ---
    def return_order(self, return_id, order_id, lines):
        order = self.orders.get(order_id)
        if order is None:
            raise ValueError(f"unknown order {order_id}")
        payload = _lines(lines)
        shipped = order.fields.get("shipped") or {}
        for sku, qty in payload.items():
            if qty > shipped.get(sku, 0):
                raise ValueError(f"cannot return more than shipped for {sku}")
        self._unique(self.returns, "return", return_id)
        self.returns[return_id] = _Record(payload, order_id=order_id, order=order)

    def refund_return(self, return_id):
        record = self.returns.get(return_id)
        if record is None:
            raise ValueError(f"unknown return {return_id}")
        if record.state != "open":
            raise ValueError("return already refunded")
        order = record.fields["order"]
        warehouse_id = order.fields["warehouse"]
        for sku, qty in record.lines.items():
            bucket = self._bucket(warehouse_id, sku)
            bucket["available"] += qty
        record.state = "refunded"
        self.movements.append({"kind": "refund", "return": return_id, "lines": record.lines})

    # ------------------------------------------------------------ reports ---
    def inventory_report(self):
        rows = []
        for (warehouse_id, sku), bucket in sorted(self._stock.items()):
            if bucket["available"] == 0 and bucket["reserved"] == 0:
                continue
            rows.append({"warehouse": warehouse_id, "sku": sku, **bucket})
        return {"stock": rows, "warehouses": sorted(self.warehouses), "products": sorted(self.products)}

    def sales_report(self):
        rows = []
        for order_id, order in sorted(self.orders.items()):
            if order.state in ("shipped", "returned"):
                rows.append({"order": order_id, "customer": order.fields["customer_id"],
                             "total": str(sum(_money(order.lines, self.products), Decimal("0")))})
        refunds = []
        for return_id, record in sorted(self.returns.items()):
            if record.state == "refunded":
                refunds.append({"return": return_id, "order": record.fields["order_id"]})
        return {"orders": rows, "refunds": refunds, "movements": len(self.movements)}

    # --------------------------------------------------------- persistence ---
    def _payload(self):
        stock = [{"warehouse": w, "sku": sku, **bucket} for (w, sku), bucket in sorted(self._stock.items())]
        return {
            "version": 1,
            "warehouses": sorted(self.warehouses.values(), key=lambda x: x["id"]),
            "products": sorted(self.products.values(), key=lambda x: x["sku"]),
            "stock": stock,
            "orders": {k: v.as_dict() for k, v in sorted(self.orders.items())},
            "transfers": {k: v.as_dict() for k, v in sorted(self.transfers.items())},
            "purchase_orders": {k: v.as_dict() for k, v in sorted(self.purchase_orders.items())},
            "returns": {k: {**v.as_dict(), "order_id": v.fields["order_id"]} for k, v in sorted(self.returns.items())},
        }

    def save(self):
        payload = self._payload()
        text = json.dumps(payload, sort_keys=True, indent=2)
        checksum = hashlib.sha256(text.encode("utf8")).hexdigest()
        document = {"payload": payload, "checksum": checksum}
        if not self.data_path:
            raise ValueError("no data path configured")
        directory = os.path.dirname(os.path.abspath(self.data_path)) or "."
        os.makedirs(directory, exist_ok=True)
        handle = tempfile.NamedTemporaryFile("w", dir=directory, delete=False, encoding="utf8", suffix=".tmp")
        try:
            json.dump(document, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            handle.close()
        os.replace(handle.name, self.data_path)
        return self.data_path

    def load(self):
        if not self.data_path or not os.path.exists(self.data_path):
            raise ValueError("no persisted data")
        with open(self.data_path, encoding="utf8") as fh:
            document = json.load(fh)
        payload = document.get("payload", document)
        expected = hashlib.sha256(json.dumps(payload, sort_keys=True, indent=2).encode("utf8")).hexdigest()
        if document.get("checksum") != expected:
            raise ValueError("checksum mismatch")
        # everything validated: only now swap the live state
        self.warehouses = {w["id"]: dict(w) for w in payload["warehouses"]}
        self.products = {p["sku"]: dict(p) for p in payload["products"]}
        self._stock = {(row["warehouse"], row["sku"]): {"available": row["available"], "reserved": row["reserved"]}
                      for row in payload["stock"]}
        self.orders = {k: _record_from(v) for k, v in payload.get("orders", {}).items()}
        self.transfers = {k: _record_from(v) for k, v in payload.get("transfers", {}).items()}
        self.purchase_orders = {k: _record_from(v) for k, v in payload.get("purchase_orders", {}).items()}
        self.returns = {k: _record_from(v) for k, v in payload.get("returns", {}).items()}
        return True


def _money(line_map, products):
    return [Decimal(products[sku]["price"]) * qty for sku, qty in line_map.items() if sku in products]


def _record_from(entry):
    record = _Record(entry.get("lines", {}), **{k: v for k, v in entry.items() if k not in ("lines", "state")})
    record.state = entry.get("state", "open")
    return record


