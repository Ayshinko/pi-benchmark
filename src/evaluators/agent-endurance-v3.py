"""Hidden deterministic evaluator. Kept outside every evaluated workspace."""
import copy, importlib, json, os, subprocess, sys, tempfile, traceback

ROOT = os.path.abspath(sys.argv[1]); sys.path.insert(0, ROOT)
results=[]
def check(category, name, fn):
    try: fn(); results.append((category,name,True,""))
    except Exception as e: results.append((category,name,False,f"{type(e).__name__}: {e}"))
def eq(a,b):
    if a != b: raise AssertionError(f"{a!r} != {b!r}")
def raises(fn):
    try: fn()
    except (ValueError, KeyError): return
    raise AssertionError("operation did not fail")
def system(path=None):
    m=importlib.import_module("warehouse"); return m.WarehouseSystem(path)
def seeded(path=None):
    s=system(path); s.add_warehouse("w1","One"); s.add_warehouse("w2","Two"); s.add_product("sku","Widget","12.50"); s.stock("w1","sku",10); return s

check("api","import contract",lambda: system())
check("inventory","multi warehouse",lambda: (lambda s:(eq(s.inventory("w1","sku"),10),eq(s.inventory("w2","sku"),0)))(seeded()))
def reservation():
    s=seeded(); s.create_order("o","c",{"sku":4}); s.reserve_order("o","w1"); eq(s.inventory("w1","sku"),6); s.ship_order("o"); eq(s.inventory("w1","sku"),6)
check("orders","reserve and ship",reservation)
def atomic_reserve():
    s=seeded(); s.add_product("x","X","1"); s.stock("w1","x",1); s.create_order("o","c",{"sku":3,"x":2}); before=copy.deepcopy(s.inventory_report()); raises(lambda:s.reserve_order("o","w1")); eq(s.inventory_report(),before)
check("transactions","atomic reservation failure",atomic_reserve)
def transfer():
    s=seeded(); s.create_transfer("t","w1","w2",{"sku":6}); s.ship_transfer("t"); eq(s.inventory("w1","sku"),4); s.receive_transfer("t",{"sku":2}); eq(s.inventory("w2","sku"),2); s.receive_transfer("t",{"sku":4}); eq(s.inventory("w2","sku"),6); raises(lambda:s.receive_transfer("t",{"sku":1}))
check("transfers","partial receive and bound",transfer)
def po():
    s=seeded(); s.create_purchase_order("p","sup","w2",{"sku":5}); s.receive_purchase_order("p",{"sku":2}); eq(s.inventory("w2","sku"),2); raises(lambda:s.receive_purchase_order("p",{"sku":4})); eq(s.inventory("w2","sku"),2)
check("purchasing","receiving constraint",po)
def returns():
    s=seeded(); s.create_order("o","c",{"sku":2}); s.reserve_order("o","w1"); s.ship_order("o"); s.return_order("r","o",{"sku":1}); s.refund_return("r"); before=copy.deepcopy(s.sales_report()); raises(lambda:s.refund_return("r")); eq(s.sales_report(),before)
check("returns","duplicate refund prevention",returns)
def persistence():
    with tempfile.TemporaryDirectory() as d:
      p=os.path.join(d,"db.json"); s=seeded(p); s.save(); q=system(p); q.load(); eq(q.inventory("w1","sku"),10); data=json.load(open(p,encoding="utf8")); data["checksum"]="bad"; open(p,"w",encoding="utf8").write(json.dumps(data)); before=copy.deepcopy(q.inventory_report()); raises(q.load); eq(q.inventory_report(),before)
check("persistence","roundtrip and tamper rejection",persistence)
def cli():
    with tempfile.TemporaryDirectory() as d:
      p=os.path.join(d,"db.json"); base=[sys.executable,"-m","warehouse","--data",p]
      for args in (["add-warehouse","w1","One"],["add-product","sku","Widget","12.50"],["stock","w1","sku","3"],["inventory","w1","sku"]):
        r=subprocess.run(base+list(args),cwd=ROOT,text=True,capture_output=True,timeout=10)
        if r.returncode: raise AssertionError(r.stderr)
        json.loads(r.stdout)
check("cli","cross-process JSON CLI",cli)

cats={}
for c,n,ok,d in results:
    x=cats.setdefault(c,{"passed":0,"total":0}); x["total"]+=1; x["passed"]+=int(ok)
out={"passed":sum(x[2] for x in results),"total":len(results),"categories":cats,"details":[f"{n}: {d}" for _,n,ok,d in results if not ok]}
print(json.dumps(out,sort_keys=True))
