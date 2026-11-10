"""Deliberately incorrect Agent Endurance V3 implementation (test fixture only).

Weak semantics: no atomic validation, no checksum verification, refunds may be
applied twice, receiving is unbounded, CLI always exits zero. The hidden
evaluator must catch these, which proves the evaluator actually detects
incorrect software rather than only passing one implementation.
"""
import json
import os


class WarehouseSystem:
    def __init__(self, data_path=None):
        self.data_path = data_path
        self.warehouses = set()
        self.products = {}
        self._stock = {}
        self.orders = {}
        self.transfers = {}
        self.purchase_orders = {}
        self.returns = {}

    def add_warehouse(self, warehouse_id, name):
        self.warehouses.add(warehouse_id)

    def add_product(self, sku, name, price):
        self.products[sku] = {"name": name, "price": price}

    def _entry(self, warehouse_id, sku):
        return self._stock.setdefault((warehouse_id, sku), {"available": 0, "reserved": 0})

    def stock(self, warehouse_id, sku, qty):
        self._entry(warehouse_id, sku)["available"] += qty
        return qty

    def inventory(self, warehouse_id, sku):
        return dict(self._entry(warehouse_id, sku))

    def create_order(self, order_id, customer_id, lines):
        payload = lines if isinstance(lines, dict) else {entry["sku"]: entry["qty"] for entry in lines}
        self.orders[order_id] = {"lines": payload, "customer": customer_id, "warehouse": None, "shipped": {}}

    def reserve_order(self, order_id, warehouse_id):
        order = self.orders[order_id]
        for sku, qty in order["lines"].items():
            entry = self._entry(warehouse_id, sku)
            entry["available"] -= qty          # mutates before validating: not atomic
            entry["reserved"] += qty
        order["warehouse"] = warehouse_id

    def ship_order(self, order_id):
        order = self.orders[order_id]
        entry_key = order["warehouse"]
        for sku, qty in order["lines"].items():
            self._entry(entry_key, sku)["reserved"] -= qty
            order["shipped"][sku] = order["shipped"].get(sku, 0) + qty

    def create_transfer(self, transfer_id, source, destination, lines):
        payload = lines if isinstance(lines, dict) else {entry["sku"]: entry["qty"] for entry in lines}
        self.transfers[transfer_id] = {"source": source, "destination": destination, "lines": payload}

    def ship_transfer(self, transfer_id):
        transfer = self.transfers[transfer_id]
        for sku, qty in transfer["lines"].items():
            self._entry(transfer["source"], sku)["available"] -= qty

    def receive_transfer(self, transfer_id, quantities):
        transfer = self.transfers[transfer_id]
        payload = quantities if isinstance(quantities, dict) else {e["sku"]: e["qty"] for e in quantities}
        for sku, qty in payload.items():
            self._entry(transfer["destination"], sku)["available"] += qty   # unbounded

    def create_purchase_order(self, po_id, supplier_id, warehouse_id, lines):
        payload = lines if isinstance(lines, dict) else {e["sku"]: e["qty"] for e in lines}
        self.purchase_orders[po_id] = {"warehouse": warehouse_id, "lines": payload}

    def receive_purchase_order(self, po_id, quantities):
        order = self.purchase_orders[po_id]
        payload = quantities if isinstance(quantities, dict) else {e["sku"]: e["qty"] for e in quantities}
        for sku, qty in payload.items():
            self._entry(order["warehouse"], sku)["available"] += qty        # unbounded

    def return_order(self, return_id, order_id, lines):
        payload = lines if isinstance(lines, dict) else {e["sku"]: e["qty"] for e in lines}
        self.returns[return_id] = {"order_id": order_id, "lines": payload}

    def refund_return(self, return_id):
        record = self.returns[return_id]
        order = self.orders[record["order_id"]]
        for sku, qty in record["lines"].items():
            self._entry(order["warehouse"], sku)["available"] += qty          # repeatable

    def save(self):
        rows = [{"warehouse": w, "sku": sku, **bucket} for (w, sku), bucket in self._stock.items()]
        document = {"stock": rows, "warehouses": sorted(self.warehouses)}
        with open(self.data_path, "w", encoding="utf8") as handle:
            json.dump(document, handle)

    def load(self):
        with open(self.data_path, encoding="utf8") as handle:
            document = json.load(handle)
        if not document:                                       # never validates checksum
            raise ValueError("empty document")
        self._stock = {(row["warehouse"], row["sku"]): {"available": row["available"], "reserved": row["reserved"]}
                      for row in document.get("stock", [])}
        self.warehouses = set(document.get("warehouses", []))

    def inventory_report(self):
        return {"stock": [{"warehouse": w, "sku": sku, **bucket} for (w, sku), bucket in self._stock.items()]}

    def sales_report(self):
        return {"orders": sorted(self.orders)}
