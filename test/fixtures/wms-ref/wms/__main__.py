import argparse, datetime, hashlib, json, os, sys, tempfile
from decimal import Decimal

class Rule(Exception):
    def __init__(self, code, message="rule violation"):
        self.code, self.message = code, message

UNKNOWN = {"warehouse":"UNKNOWN_WAREHOUSE","sku":"UNKNOWN_SKU","order":"UNKNOWN_ORDER",
           "transfer":"UNKNOWN_TRANSFER","po":"UNKNOWN_PO","return":"UNKNOWN_RETURN"}

def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def empty():
    return {"warehouses":{},"skus":{},"stock":{},"orders":{},"transfers":{},"pos":{},"returns":{}}

def load(path):
    if not os.path.exists(path): return empty()
    try:
        doc=json.load(open(path,encoding="utf8"))
        if doc.get("schema_version") != 1 or doc.get("checksum") != digest(doc.get("data")): raise ValueError()
        return doc["data"]
    except Exception: raise Rule("INTEGRITY_ERROR","invalid data file")

def save(path,data):
    os.makedirs(os.path.dirname(os.path.abspath(path)),exist_ok=True)
    doc={"schema_version":1,"checksum":digest(data),"data":data}
    fd,tmp=tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)),prefix=".wms-",suffix=".tmp")
    try:
        with os.fdopen(fd,"w",encoding="utf8") as f:
            json.dump(doc,f,sort_keys=True,separators=(",",":")); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def need(data,kind,key):
    table={"warehouse":"warehouses","sku":"skus","order":"orders","transfer":"transfers","po":"pos","return":"returns"}[kind]
    if key not in data[table]: raise Rule(UNKNOWN[kind],"unknown "+kind)

def lines(values):
    out={}
    for value in values or []:
        try: sku,raw=value.rsplit(":",1); qty=int(raw)
        except Exception: raise Rule("INVALID_QUANTITY")
        if qty <= 0 or sku in out: raise Rule("INVALID_QUANTITY")
        out[sku]=qty
    if not out: raise Rule("INVALID_QUANTITY")
    return out

def row(data,w,sku):
    return data["stock"].setdefault(w,{}).setdefault(sku,{"on_hand":0,"reserved":0})

def result(value): print(json.dumps({"ok":True,"result":value},sort_keys=True))

def parser():
    p=argparse.ArgumentParser(); p.add_argument("--data",default="wms_data.json"); top=p.add_subparsers(dest="group",required=True)
    groups={}
    def leaf(group,name):
        if group not in groups: groups[group]=top.add_parser(group).add_subparsers(dest="action",required=True)
        return groups[group].add_parser(name)
    q=leaf("warehouse","add"); q.add_argument("--id",required=True); q.add_argument("--name",required=True)
    q=leaf("sku","add"); q.add_argument("--sku",required=True); q.add_argument("--name",required=True); q.add_argument("--price",required=True)
    q=leaf("stock","adjust"); q.add_argument("--warehouse",required=True); q.add_argument("--sku",required=True); q.add_argument("--qty",type=int,required=True)
    q=leaf("stock","show"); q.add_argument("--warehouse"); q.add_argument("--sku")
    for action in ("create","cancel","ship"):
        q=leaf("order",action); q.add_argument("--id",required=True)
        if action=="create": q.add_argument("--warehouse",required=True); q.add_argument("--line",action="append",required=True)
    q=leaf("transfer","create"); q.add_argument("--id",required=True); q.add_argument("--from",dest="source",required=True); q.add_argument("--to",required=True); q.add_argument("--line",action="append",required=True)
    q=leaf("transfer","receive"); q.add_argument("--id",required=True); q.add_argument("--line",action="append",required=True)
    q=leaf("po","create"); q.add_argument("--id",required=True); q.add_argument("--supplier",required=True); q.add_argument("--warehouse",required=True); q.add_argument("--line",action="append",required=True)
    q=leaf("po","receive"); q.add_argument("--id",required=True); q.add_argument("--line",action="append",required=True)
    q=leaf("return","create"); q.add_argument("--id",required=True); q.add_argument("--order",required=True); q.add_argument("--line",action="append",required=True)
    q=leaf("refund","issue"); q.add_argument("--return",dest="return_id",required=True)
    q=leaf("report","stock")
    q=leaf("report","sales"); q.add_argument("--from",dest="date_from"); q.add_argument("--to",dest="date_to")
    top.add_parser("check")
    return p

def run(a,d):
    g,x=a.group,getattr(a,"action",None)
    if g=="warehouse":
        if a.id in d["warehouses"]: raise Rule("DUPLICATE_ID")
        d["warehouses"][a.id]=a.name; return {"id":a.id}
    if g=="sku":
        if a.sku in d["skus"]: raise Rule("DUPLICATE_ID")
        try: price=Decimal(a.price); assert str(price)==a.price and price.as_tuple().exponent==-2
        except Exception: raise Rule("INVALID_QUANTITY","invalid money")
        d["skus"][a.sku]={"name":a.name,"price":a.price}; return {"sku":a.sku}
    if g=="stock" and x=="adjust":
        need(d,"warehouse",a.warehouse); need(d,"sku",a.sku); r=row(d,a.warehouse,a.sku)
        if a.qty==0 or r["on_hand"]+a.qty<r["reserved"]: raise Rule("INVALID_QUANTITY")
        r["on_hand"]+=a.qty; return {**r,"available":r["on_hand"]-r["reserved"]}
    if g=="stock" and x=="show":
        rows=[]
        for w,items in d["stock"].items():
            for sku,r in items.items():
                if (not a.warehouse or a.warehouse==w) and (not a.sku or a.sku==sku): rows.append({"warehouse":w,"sku":sku,**r,"available":r["on_hand"]-r["reserved"]})
        return {"stock":sorted(rows,key=lambda z:(z["warehouse"],z["sku"]))}
    if g=="order" and x=="create":
        if a.id in d["orders"]: raise Rule("DUPLICATE_ID")
        need(d,"warehouse",a.warehouse); ls=lines(a.line)
        for sku,q in ls.items(): need(d,"sku",sku); truth=row(d,a.warehouse,sku); 
        if any(row(d,a.warehouse,s)["on_hand"]-row(d,a.warehouse,s)["reserved"]<q for s,q in ls.items()): raise Rule("INSUFFICIENT_STOCK")
        for s,q in ls.items(): row(d,a.warehouse,s)["reserved"]+=q
        d["orders"][a.id]={"warehouse":a.warehouse,"lines":ls,"prices":{s:d["skus"][s]["price"] for s in ls},"status":"RESERVED"}; return {"id":a.id,"status":"RESERVED"}
    if g=="order" and x in ("cancel","ship"):
        need(d,"order",a.id); o=d["orders"][a.id]
        if o["status"]!="RESERVED": raise Rule("INVALID_STATE")
        for s,q in o["lines"].items(): row(d,o["warehouse"],s)["reserved"]-=q; row(d,o["warehouse"],s)["on_hand"]-=q if x=="ship" else 0
        o["status"]="SHIPPED" if x=="ship" else "CANCELLED"; o["time"]=os.getenv("WMS_NOW",datetime.datetime.now(datetime.timezone.utc).isoformat()); return {"id":a.id,"status":o["status"]}
    if g=="transfer" and x=="create":
        if a.id in d["transfers"]: raise Rule("DUPLICATE_ID")
        need(d,"warehouse",a.source); need(d,"warehouse",a.to); ls=lines(a.line)
        if any(row(d,a.source,s)["on_hand"]-row(d,a.source,s)["reserved"]<q for s,q in ls.items()): raise Rule("INSUFFICIENT_STOCK")
        for s,q in ls.items(): need(d,"sku",s); row(d,a.source,s)["on_hand"]-=q
        d["transfers"][a.id]={"source":a.source,"to":a.to,"sent":ls,"received":{s:0 for s in ls},"status":"IN_TRANSIT"}; return {"id":a.id,"status":"IN_TRANSIT"}
    if g=="transfer" and x=="receive":
        need(d,"transfer",a.id); t=d["transfers"][a.id]; ls=lines(a.line)
        if any(s not in t["sent"] or t["received"][s]+q>t["sent"][s] for s,q in ls.items()): raise Rule("OVER_RECEIVE")
        for s,q in ls.items(): t["received"][s]+=q; row(d,t["to"],s)["on_hand"]+=q
        t["status"]="RECEIVED" if t["received"]==t["sent"] else "PARTIAL"; return {"id":a.id,"status":t["status"],"lines":[{"sku":s,"sent":q,"received":t["received"][s]} for s,q in t["sent"].items()]}
    if g=="po" and x=="create":
        if a.id in d["pos"]: raise Rule("DUPLICATE_ID")
        need(d,"warehouse",a.warehouse); ls=lines(a.line); d["pos"][a.id]={"warehouse":a.warehouse,"ordered":ls,"received":{s:0 for s in ls},"status":"OPEN"}; return {"id":a.id,"status":"OPEN"}
    if g=="po" and x=="receive":
        need(d,"po",a.id); po=d["pos"][a.id]
        if po["status"]=="CLOSED": raise Rule("INVALID_STATE")
        ls=lines(a.line)
        if any(s not in po["ordered"] or po["received"][s]+q>po["ordered"][s] for s,q in ls.items()): raise Rule("OVER_RECEIVE")
        for s,q in ls.items(): po["received"][s]+=q; row(d,po["warehouse"],s)["on_hand"]+=q
        po["status"]="CLOSED" if po["received"]==po["ordered"] else "PARTIAL"; return {"id":a.id,"status":po["status"],"lines":[{"sku":s,"ordered":q,"received":po["received"][s]} for s,q in po["ordered"].items()]}
    if g=="return" and x=="create":
        if a.id in d["returns"]: raise Rule("DUPLICATE_ID")
        need(d,"order",a.order); o=d["orders"][a.order]; ls=lines(a.line)
        if o["status"]!="SHIPPED" or any(s not in o["lines"] or q>o["lines"][s] for s,q in ls.items()): raise Rule("RETURN_EXCEEDS_SHIPPED")
        for s,q in ls.items(): row(d,o["warehouse"],s)["on_hand"]+=q
        d["returns"][a.id]={"order":a.order,"lines":ls,"refunded":False}; return {"id":a.id,"order":a.order}
    if g=="refund":
        need(d,"return",a.return_id); r=d["returns"][a.return_id]
        if r["refunded"]: raise Rule("DUPLICATE_REFUND")
        o=d["orders"][r["order"]]; amount=sum(Decimal(o["prices"][s])*q for s,q in r["lines"].items()); r["refunded"]=True; return {"return":a.return_id,"amount":format(amount,".2f")}
    if g=="report" and x=="stock":
        totals={}
        for items in d["stock"].values():
            for s,r in items.items(): z=totals.setdefault(s,{"sku":s,"on_hand":0,"reserved":0,"available":0}); z["on_hand"]+=r["on_hand"]; z["reserved"]+=r["reserved"]; z["available"]+=r["on_hand"]-r["reserved"]
        return {"rows":[totals[s] for s in sorted(totals)]}
    if g=="report" and x=="sales":
        shipped=[o for o in d["orders"].values() if o["status"]=="SHIPPED"]; units=sum(sum(o["lines"].values()) for o in shipped); revenue=sum(sum(Decimal(o["prices"][s])*q for s,q in o["lines"].items()) for o in shipped); refunds=sum(sum(Decimal(d["orders"][r["order"]]["prices"][s])*q for s,q in r["lines"].items()) for r in d["returns"].values() if r["refunded"]); return {"orders_shipped":len(shipped),"units_sold":units,"revenue":format(revenue,".2f"),"refunds":format(refunds,".2f"),"net_revenue":format(revenue-refunds,".2f"),"by_sku":[]}
    if g=="check": return {"valid":True}
    raise Rule("INVALID_STATE")

def main():
    a=parser().parse_args()
    try:
        d=load(a.data); out=run(a,d)
        if not (a.group=="stock" and a.action=="show") and a.group not in ("report","check"): save(a.data,d)
        result(out)
    except Rule as e:
        code=5 if e.code=="INTEGRITY_ERROR" else 4 if e.code.startswith("UNKNOWN_") else 3
        print(json.dumps({"ok":False,"error":{"code":e.code,"message":e.message}})); sys.exit(code)
if __name__=="__main__": main()
