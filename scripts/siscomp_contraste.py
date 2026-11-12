#!/usr/bin/env python3
"""
SisCOMP → SIGUELO · contraste de entregas parciales o no realizadas
DINALOG · Torre de Control · CSS

Lee el extracto de SisCOMP (Dirección Nacional de Compras), separa la columna
DESCRIPCION_PRODUCTO en sus campos (CODIGO / PRODUCTO / CANTIDAD / PRECIO UNIT.),
traduce el código SAP-SAFIRO a código de Abasto con la matriz de intercambios
(MAESTRO_RENGLONES de la Base de Datos de Citas, tal como la publican SIGUELO y
la conciliación SALMI–SAP) y escribe data/siscomp_contraste.json para el
Expediente de Incumplimiento. No infiere cantidades.

Uso:
  python3 scripts/siscomp_contraste.py RUTA_REPO_SIGUELO ACTUAL.xlsx [ANTERIOR.xlsx]
  ACTUAL   = requisiciones desde el 31-10-2024 (administración actual)
  ANTERIOR = requisiciones anteriores al 31-10-2024
  (Un solo archivo sin FECHA_REQ también funciona: la administración queda vacía.)
"""
import sys, re, json, collections, unicodedata, difflib, datetime
import pandas as pd

def limpiar(x): return re.sub(r'\s+', ' ', re.sub(r'<br\s*/?>', ' ', str(x))).strip()
def arreglar(t):
    t = str(t)
    if re.search('Ã|Â', t):
        try: t = t.encode('latin1').decode('utf8')
        except Exception: pass
    return t
def norm(t):
    t = unicodedata.normalize('NFKD', arreglar(t)).encode('ascii', 'ignore').decode().upper()
    return re.sub(r'[^A-Z0-9]+', ' ', t).strip()

CLAVE = re.compile(r'(?:\*{1,3}|=>)\s*(CODIGO|PRODUCTO|MATERIAL, BIEN O SERVICIO|CANTIDAD|PRECIO UNIT\.?)\s*:', re.I)
MAPA = {'MATERIAL, BIEN O SERVICIO': 'prod', 'PRODUCTO': 'prod', 'CODIGO': 'cod', 'CANTIDAD': 'cant', 'PRECIO UNIT': 'pu'}

def separar(x):
    """Devuelve (formato, [renglones]) a partir del texto de la columna G."""
    t = limpiar(x); ms = list(CLAVE.finditer(t))
    if not ms:
        partes = [limpiar(p).strip(' ,') for p in str(x).split('\n,')]
        return ('D' if len(partes) > 1 else 'E'), [{'prod': p} for p in dict.fromkeys(p for p in partes if p)]
    seg = []
    m0 = re.match(r'\s*(MATERIAL, BIEN O SERVICIO|CODIGO|PRODUCTO)\s*:(.*)', t[:ms[0].start()], re.I)
    if m0: seg.append((m0.group(1).upper(), m0.group(2).strip(' *=>')))
    for i, m in enumerate(ms):
        seg.append((m.group(1).upper().rstrip('.'), t[m.end(): ms[i+1].start() if i+1 < len(ms) else len(t)].strip(' *=>')))
    items, cur = [], {}
    for k, v in seg:
        k = MAPA[k]
        if k in cur or (k == 'cod' and cur): items.append(cur); cur = {}
        cur[k] = v
    if cur: items.append(cur)
    for it in items:
        for f in ('cant', 'pu'):
            if f in it:
                try: it[f] = float(re.sub(r'[^\d.]', '', it[f]))
                except ValueError: it[f] = None
    fmt = 'A' if any('cod' in i for i in items) else ('C' if '=>' in t else 'B')
    return fmt, items

def tipo(c):
    c = (c or '').strip()
    if not c: return 'SIN'
    if re.fullmatch(r'\d{9}', c): return 'ABASTO'
    if re.fullmatch(r'[A-Za-z]{1,2}[A-Za-z0-9]{6,9}', c) and re.search(r'\d{3}$', c): return 'SAP'
    return 'OTRO'

def matriz(S):
    pares = collections.defaultdict(collections.Counter); cat = {}
    m = json.load(open(S + '/maestro_renglones.json'))
    for _, l in m['catalogo'].items():
        for r in l:
            pares[str(r['cod_sap']).strip().upper()][str(r['cod_abasto'])] += 1; cat.setdefault(str(r['cod_abasto']), r['desc'])
    for r in json.load(open(S + '/entradas_recepcion.json'))['rows']:
        if r.get('cod') and r.get('mat'): pares[str(r['mat']).upper()][str(r['cod'])] += 1
        if r.get('cod') and r.get('desc'): cat.setdefault(str(r['cod']), r['desc'])
    for r in json.load(open(S + '/kardex/conciliacion_salmi_sap.json'))['rows']:
        if r[0] and r[1]: pares[str(r[1]).upper()][str(r[0])] += 1
        cat.setdefault(str(r[0]), r[2])
    return {k: v.most_common(1)[0][0] for k, v in pares.items()}, cat

def main(S, actual, anterior=None):
    partes = [pd.read_excel(actual).assign(_adm='actual')]
    if anterior: partes.append(pd.read_excel(anterior).assign(_adm='anterior'))
    s = pd.concat(partes, ignore_index=True)
    if 'FECHA_REQ' not in s: s['FECHA_REQ'] = None; s['FECHA_OC'] = None; s['_adm'] = ''
    s['_fila'] = s.groupby('_adm').cumcount() + 2
    sap2ab, cat = matriz(S)
    cn = {k: norm(v) for k, v in cat.items() if v}; tok = {k: set(v.split()) for k, v in cn.items()}
    inv = collections.defaultdict(set)
    for k, t in tok.items():
        for w in t:
            if len(w) > 3: inv[w].add(k)
    def sugerir(p):
        q = norm(p); qt = set(q.split()); cands = collections.Counter()
        for w in qt:
            if len(w) > 3 and len(inv[w]) < 400:
                for k in inv[w]: cands[k] += 1
        best, bs = None, 0
        for k, _ in cands.most_common(40):
            sc = .5 * difflib.SequenceMatcher(None, q[:70], cn[k][:70]).ratio() + .5 * len(qt & tok[k]) / max(1, len(qt | tok[k]))
            if sc > bs: best, bs = k, sc
        f1 = lambda t: next((w for w in norm(t).split() if len(w) > 3), '')
        if best and bs >= .55 and f1(p) == f1(cat[best]): return best, ('propuesto' if bs >= .8 else 'revisar')
        return None, None
    filas = []
    for _, r in s.iterrows():
        raw = str(r.DESCRIPCION_PRODUCTO); fmt, items = separar(raw)
        v = pd.to_datetime(r.FECHA_VENCIMIENTO_ENTREGA)
        bloque = 'vigente' if v >= pd.Timestamp('2025-12-01') else ('transicion' if v >= pd.Timestamp('2025-06-01') else 'historico')
        al = []
        if len(raw) >= 1000: al.append('texto cortado')
        if re.search('Ã|Â', raw): al.append('acentos dañados')
        if len(items) > 1: al.append('paquete de %d renglones' % len(items))
        pu0 = items[0].get('pu') if len(items) == 1 else None
        inflado = (pu0 and r.CANTIDAD_PRODUCTO and r.IMPORTE_RENGLON / (r.CANTIDAD_PRODUCTO * pu0) > 50) or (not pu0 and r.IMPORTE_RENGLON > 1e8)
        if inflado: al.append('importe inflado (precio sin decimales)')
        imp_real = (r.CANTIDAD_PRODUCTO * pu0 if pu0 else r.IMPORTE_RENGLON / 1e5) if inflado else float(r.IMPORTE_RENGLON)
        saldo_real = max(0.0, imp_real - float(r.TOTAL_ENTREGADO or 0))
        fq = pd.to_datetime(r.FECHA_REQ).strftime('%Y-%m-%d') if pd.notna(r.FECHA_REQ) else ''
        fo = pd.to_datetime(r.FECHA_OC).strftime('%Y-%m-%d') if pd.notna(r.FECHA_OC) else ''
        for it in items:
            c = (it.get('cod') or '').strip(); t = tipo(c); ab, conf = None, None
            if t == 'ABASTO': ab, conf = c, 'exacto'
            elif t == 'SAP' and c.upper() in sap2ab: ab, conf = sap2ab[c.upper()], 'exacto'
            elif it.get('prod') and len(items) == 1: ab, conf = sugerir(it['prod'])
            filas.append([str(int(r.NUM_SAP)), str(int(r.NUM_ORDEN)), ab or '', c.upper() if t == 'SAP' else '', conf or 'sin código',
                          v.strftime('%Y-%m-%d'), str(r.NOMBRE_ALMACEN).strip(), str(r.ESTADO_ENTREGA).strip(),
                          round(imp_real, 2), round(saldo_real, 2), '; '.join(al), bloque,
                          arreglar(limpiar(it.get('prod') or ''))[:90], int(r._fila), r._adm, fq, fo])
    cols = ['oc', 'ped', 'cod', 'codSap', 'conf', 'venc', 'alm', 'est', 'imp', 'saldo', 'alerta', 'bloque', 'prod', 'fila', 'adm', 'fReq', 'fOC']
    meta = {'fuente': 'SisCOMP+ · Dirección Nacional de Compras · entregas parciales o no realizadas (unidad 08-12)',
            'archivo': ' + '.join(x.split('/')[-1] for x in [actual, anterior] if x),
            'corteAdministracion': 'FECHA_REQ desde 2024-10-31 = actual', 'generado': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
            'filasSisCOMP': int(len(s)), 'renglones': len(filas),
            'bloques': {'vigente': 'vence desde 2025-12-01 (ventana del libro de Incumplimientos)', 'transicion': '2025-06-01 a 2025-11-30', 'historico': 'antes de 2025-06-01'},
            'matriz': 'MAESTRO_RENGLONES (Base de Datos de Citas) vía maestro_renglones, Recepción y conciliación SALMI–SAP',
            'nota': 'No se infieren cantidades. imp = IMPORTE_RENGLON de SisCOMP; si viene inflado (precio leído sin decimales) se recalcula como CANTIDAD_PRODUCTO × precio del texto, o ÷100.000 si no trae precio. saldo = imp − TOTAL_ENTREGADO.'}
    return {'_meta': meta, 'cols': cols, 'rows': filas}

if __name__ == '__main__':
    out = main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    json.dump(out, open('data/siscomp_contraste.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    c = collections.Counter((r[14], r[11], r[4]) for r in out['rows'])
    print(out['_meta']['renglones'], 'renglones', dict(c))
