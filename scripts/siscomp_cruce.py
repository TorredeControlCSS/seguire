#!/usr/bin/env python3
"""
SisCOMP → Expediente de Incumplimiento · cruce CON CERTEZA
DINALOG · Torre de Control · CSS

Clasifica cada fila de los extractos de SisCOMP+ (por administración) en:
  CERRAR      el libro de Seguimiento registra la entrega completa (misma OC, código y CEDIS, fecha dentro de sus notas)
  CONFIRMADO  vencida, y el libro tiene una nota vencida con saldo para la misma OC, código y CEDIS
  POR VENCER  todavía no vence
  INCIERTO    todo lo demás (va al informe de revisión, hallazgos H1–H8)
Solo CERRAR y CONFIRMADO se publican en data/siscomp_cruce.json para el tablero.

Uso (desde la raíz del repo seguire):
  python3 scripts/siscomp_cruce.py RUTA_REPO_SIGUELO ACTUAL.xlsx ANTERIOR.xlsx
"""
import pandas as pd,json,collections,sys,re,datetime,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__))); import siscomp_contraste as sc
SIG,ACT,ANT=sys.argv[1],sys.argv[2],sys.argv[3]
N=pd.read_excel(ACT).assign(adm='Actual',archivo=ACT.split('/')[-1])
A=pd.read_excel(ANT).assign(adm='Anterior',archivo=ANT.split('/')[-1])
N['fila']=N.index+2; A['fila']=A.index+2
S=pd.concat([N,A],ignore_index=True)
HOY=pd.Timestamp(datetime.date.today())
S['venc']=pd.to_datetime(S.FECHA_VENCIMIENTO_ENTREGA); S['freq']=pd.to_datetime(S.FECHA_REQ); S['foc']=pd.to_datetime(S.FECHA_OC)
sap2ab,cat=sc.matriz(SIG)
CED={'PANAMA - CENTRO DE DISTRIBUCION PANAMA (CEDIS)':'CDPA','ALMACEN DIVISA (CEDIS)':'CDDI','CHIRIQUI - ALMACEN CHIRIQUI (CEDIS)':'CDCH'}
def info(r):
  raw=str(r.DESCRIPCION_PRODUCTO); fmt,items=sc.separar(raw)
  c=[]; 
  for it in items:
    cd=(it.get('cod') or '').strip().upper(); t=sc.tipo(cd)
    ab=cd if t=='ABASTO' else (sap2ab.get(cd) if t=='SAP' else None)
    c.append((cd,t,ab,it.get('prod'),it.get('cant'),it.get('pu')))
  return pd.Series({'fmt':fmt,'n_items':len(items),'items':c,'largo':len(raw),'mojibake':bool(re.search('Ã|Â',raw))})
S=pd.concat([S,S.apply(info,axis=1)],axis=1)
S['pu']=S.apply(lambda r:r['items'][0][5] if r.n_items==1 else None,axis=1)
S['cod_txt']=S.apply(lambda r:r['items'][0][0] if r.n_items==1 else '',axis=1)
S['tipo_cod']=S.apply(lambda r:r['items'][0][1] if r.n_items==1 else 'PAQUETE',axis=1)
S['cod_ab']=S.apply(lambda r:r['items'][0][2] if r.n_items==1 else None,axis=1)
import html as _h
S['prod']=S.apply(lambda r:sc.arreglar(_h.unescape(sc.limpiar(r['items'][0][3] or ''))) if r.n_items==1 else sc.arreglar(_h.unescape(sc.limpiar(str(r.DESCRIPCION_PRODUCTO))))[:160],axis=1)
rat=S.IMPORTE_RENGLON/(S.CANTIDAD_PRODUCTO*S.pu.astype(float))
S['inflado']=((S.pu.notna())&(rat>50))|((S.pu.isna())&(S.IMPORTE_RENGLON>1e8))
S['imp_real']=S.IMPORTE_RENGLON.astype(float)
m=S.inflado&S.pu.notna(); S.loc[m,'imp_real']=S.CANTIDAD_PRODUCTO[m]*S.pu[m]
m=S.inflado&S.pu.isna(); S.loc[m,'imp_real']=S.IMPORTE_RENGLON[m]/1e5
S['saldo_real']=(S.imp_real-S.TOTAL_ENTREGADO).clip(lower=0)
S['cedis']=S.NOMBRE_ALMACEN.str.strip().map(CED)
S['tramo']=S.venc.map(lambda v:'Por vencer' if v>=HOY else ('Vencida dic-25 a hoy' if v>=pd.Timestamp('2025-12-01') else ('Vencida jun–nov 25' if v>=pd.Timestamp('2025-06-01') else 'Vencida antes de jun-25')))
# libro
L=json.load(open('data/cumplimiento_entregas.json'));cl=L['cols']
R=pd.DataFrame([dict(zip(cl,r)) for r in L['rows']]); R['req']=R.req.astype(str); R['cod']=R.cod.astype(str)
R['id']='EXP-'+R.req+'-'+R.nota.astype(str).str.replace(r'[^0-9A-Za-z.]','',regex=True)
LB={k:g for k,g in R.groupby(['req','cod','cedis'])}
E=pd.DataFrame(json.load(open(SIG+'/entradas_recepcion.json'))['rows']); E['oc']=E.oc.astype(str); E['cod']=E.cod.astype(str)
EO=E.groupby(['oc','cod']).agg(cant=('cant','sum'),ult=('fRec','max')).to_dict('index')
def clasif(r):
  oc=str(r.NUM_SAP)
  exacto=r.n_items==1 and isinstance(r.cod_ab,str) and bool(r.cod_ab) and not r.inflado
  if not exacto: return 'INCIERTO','',None
  if pd.isna(r.cedis): return 'INCIERTO','almacén fuera de los CEDIS',None
  g=LB.get((oc,r.cod_ab,r.cedis))
  if g is None:
    return 'INCIERTO','sin nota en el libro' + (' · Recepción registra entradas' if (oc,r.cod_ab) in EO else ''),None
  vmax=g.venc.max(); vmin=(pd.Timestamp(g.venc.min())-pd.Timedelta(days=30)).strftime('%Y-%m-%d')
  dentro=vmin<=r.venc.strftime('%Y-%m-%d')<=vmax
  if (g.saldo.fillna(0)==0).all() and g.recib.fillna(0).sum()>=g.qty.fillna(0).sum()>0 and dentro:
    return 'CERRAR','',g
  if r.venc<HOY:
    v=g[(g.venc<HOY.strftime('%Y-%m-%d'))&(g.saldo.fillna(0)>0)]
    if len(v): return 'CONFIRMADO','',v
  return 'INCIERTO',('la entrega de SisCOMP es anterior a las notas del libro' if not dentro else 'el libro y SisCOMP no coinciden en el saldo'),g
res=S.apply(clasif,axis=1,result_type='expand'); S['clase']=res[0]; S['motivo']=res[1]; S['lib']=res[2]
S['lag']=(S.foc-S.freq).dt.days
S.loc[S.motivo=='la entrega de SisCOMP es anterior a las notas del libro','motivo']='la fecha de la entrega en SisCOMP no está entre las notas del libro'
S.loc[(S.clase=='INCIERTO')&(S.tramo=='Por vencer'),'clase']='POR VENCER'
def hall(r):
  if r.clase!='INCIERTO': return ''
  if r.inflado: return 'H1'
  if r.lag<0: return 'H2'
  if r.tramo=='Vencida antes de jun-25': return 'H8'
  if r.n_items>1: return 'H3'
  if not isinstance(r.cod_ab,str) or not r.cod_ab: return 'H4'
  if pd.isna(r.cedis): return 'H5'
  if 'Recepción' in r.motivo: return 'H6'
  return 'H7'
S['hall']=S.apply(hall,axis=1)
S.loc[(S.clase!='INCIERTO')&(S.lag<0),'hall2']='H2'

def _f(v): return v.strftime('%Y-%m-%d') if pd.notna(v) else ''
out={'_meta':{'fuente':'SisCOMP+ (Dirección Nacional de Compras) cruzado con el libro de Incumplimientos de Seguimiento','archivos':[ACT.split('/')[-1],ANT.split('/')[-1]],
  'corteLibro':L.get('corte'),'generado':datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),'filasSisCOMP':int(len(S)),
  'conteo':{k:int(v) for k,v in S.clase.value_counts().items()},
  'totales':{'saldoSisCOMP':round(float(S.SALDO_PENDIENTE.sum()),2),'saldoCorregido':round(float(S.saldo_real.sum()),2),'filasInfladas':int(S.inflado.sum())},
  'regla':'Un solo renglón con código exacto e importe sin error, entregado en un CEDIS, con la misma OC, código y CEDIS en el libro y la fecha dentro de sus notas.'},
  'confirmados':[],'cerrar':[]}
for _,x in S[S.clase=='CONFIRMADO'].iterrows():
  out['confirmados'].append({'exp':list(x.lib.id),'oc':str(x.NUM_SAP),'ped':str(x.NUM_ORDEN),'cod':x.cod_ab,'cedis':x.cedis,'venc':_f(x.venc),'est':x.ESTADO_ENTREGA,'saldo':round(float(x.saldo_real),2),'adm':x.adm,'fReq':_f(x.freq),'fOC':_f(x.foc)})
for _,x in S[S.clase=='CERRAR'].iterrows():
  g=x.lib
  out['cerrar'].append({'oc':str(x.NUM_SAP),'ped':str(x.NUM_ORDEN),'cod':x.cod_ab,'cedis':x.cedis,'prov':x.NOMBRE_EMPRESA,'prod':x['prod'][:90],'venc':_f(x.venc),'est':x.ESTADO_ENTREGA,'saldo':round(float(x.saldo_real),2),
    'qty':float(g.qty.sum()),'recib':float(g.recib.sum()),'ult':str(g.ult.dropna().max() or ''),'adm':x.adm,'fReq':_f(x.freq),'fOC':_f(x.foc)})
json.dump(out,open('data/siscomp_cruce.json','w'),ensure_ascii=False,separators=(',',':'))
print(out['_meta']['conteo'],len(out['confirmados']),len(out['cerrar']))
