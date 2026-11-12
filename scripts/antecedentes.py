#!/usr/bin/env python3
"""
Expediente de Incumplimiento · VERIFICACIÓN PREVIA (antecedentes de cada nota vencida)
DINALOG · Torre de Control · CSS

Antes de pedir el informe de incumplimiento (etapa 2), cada expediente se mira contra lo
que SIGUELO ya registra ANTES y DESPUÉS del vencimiento:
  · nota de solicitud de entrega emitida y notificada (TRANSITOS_OC)
  · citas del proveedor: cuándo la pidió, para qué fecha, cuándo la confirmó CSS, si asistió
  · recepción en el CEDIS (Recepción + Kardex 101)
Clase:
  PASA          sin antecedentes que liberen al proveedor: sigue a la etapa 2
  NO_IMPUTABLE  pidió la cita a tiempo y para antes del vencimiento, y CSS la confirmó después,
                la difirió o la rechazó (Ley 419, art. 228: el atraso debe ser imputable al contratista)
  CONCILIAR     una cita marcada como asistida/entregada o la Recepción cubren el saldo,
                pero el libro de Seguimiento sigue con saldo
  VERIFICAR     hay citas del renglón alrededor del vencimiento que no se pueden atar a esta nota
Uso (desde la raíz del repo seguire): python3 scripts/antecedentes.py RUTA_REPO_SIGUELO
"""
import sys, json, collections, datetime as dt, re
S = sys.argv[1]
D = lambda s: dt.date.fromisoformat(str(s)[:10]) if s else None
HOY = dt.date.today()
L = json.load(open('data/cumplimiento_entregas.json')); C = L['cols']
R = [dict(zip(C, r)) for r in L['rows']]
LB = collections.defaultdict(list)
for r in R: LB[(str(r['req']), str(r['cod']), r.get('cedis'))].append(r)
X = [r for r in R if r['venc'] and D(r['venc']) < HOY and (r['saldo'] or 0) > 0]
T = json.load(open(S + '/citas_trazabilidad.json')); tc = T['_meta']['columnas']
CI = collections.defaultdict(list)
for r in (dict(zip(tc, x)) for x in T['rows']): CI[(str(r['ocBase']), str(r['codigo']))].append(r)
TR = collections.defaultdict(list)
for t in json.load(open(S + '/transitos_panel.json'))['transitos']:
    if t.get('tipo') == 'SOLICITUD_ENTREGA':
        TR[(str(t.get('n_orden_compra') or '')[:10], str(t.get('cod_abasto') or '').split('.')[0])].append(t)
RE = collections.defaultdict(list)
for r in json.load(open(S + '/entradas_recepcion.json'))['rows']:
    if r.get('oc') and r.get('cod') and r.get('fRec'): RE[(str(r['oc']), str(r['cod']))].append((r['fRec'], r.get('cant') or 0, 'Recepción CEDIS Panamá'))
SG = json.load(open(S + '/seguimiento_entregas.json')); sc = SG['_meta']['columnas']
for x in SG['rows']:
    r = dict(zip(sc, x))
    if r.get('fRec'): RE[(str(r['oc']), str(r['cod']))].append((r['fRec'], r.get('cant') or 0, 'Recepción · Kardex 101' if r.get('f101') else 'Recepción'))
NOTIF = {'CONFIRMADA', 'AGENDADA', 'ASISTIO', 'ENTREGADO'}
out = {}; cnt = collections.Counter()
for x in X:
    eid = 'EXP-' + str(x['req']) + '-' + re.sub(r'[^0-9A-Za-z.]', '', str(x['nota']))
    v = D(x['venc']); q = x['qty'] or 0; key = (str(x['req']), str(x['cod'])); ev = []
    # nota de solicitud de entrega
    for t in TR.get(key, []):
        if t.get('vencimiento_entrega') and abs((D(t['vencimiento_entrega']) - v).days) <= 3:
            if t.get('fecha_emision'): ev.append({'f': t['fecha_emision'], 't': 'nota', 'x': 'Nota de solicitud de entrega emitida · ' + str(t.get('n_documento') or '')[-40:] + ' · ' + f"{t.get('cantidad') or 0:,.0f} u"})
            if t.get('notificado_en'): ev.append({'f': str(t['notificado_en'])[:10], 't': 'notif', 'x': 'Notificada al proveedor' + (' por ' + t['notificado_por'] if t.get('notificado_por') else '')})
    emis = [D(t['fecha_emision']) for t in TR.get(key, []) if t.get('fecha_emision') and t.get('vencimiento_entrega') and abs((D(t['vencimiento_entrega']) - v).days) <= 3]
    emis = min(emis) if emis else None
    # citas
    ventana = [c for c in CI.get(key, []) if c['fechaSolicitada'] and -45 <= (D(c['fechaSolicitada']) - v).days <= 90]
    ligadas = [c for c in ventana if ((q and abs((c['unidades'] or 0) - q) <= 0.1 * q) or str(c['entrega']) == str(x['nota']))
               and not (emis and D(c['solicitadaEl']) < emis - dt.timedelta(days=2))]  # una cita no puede ser anterior a la nota que atiende
    cita = min(ligadas, key=lambda c: abs((D(c['fechaSolicitada']) - v).days)) if ligadas else None
    for c in sorted(ventana, key=lambda c: c['solicitadaEl']):
        tag = ' (esta nota)' if c is cita else ' (mismo renglón)'
        ev.append({'f': c['solicitadaEl'][:10], 't': 'cita', 'x': f"Proveedor pide cita para el {c['fechaSolicitada']} · {c['unidades'] or 0:,.0f} u{tag}"})
        if c['fechaConfirmada']: ev.append({'f': c['fechaConfirmada'], 't': 'conf', 'x': f"Cita del {c['fechaConfirmada']} · estado {c['estado']}" + (f" · {c['entregadas']:,.0f} u entregadas" if c.get('entregadas') else '') + tag})
    # recepción
    vis = {}
    for f, cn, src in RE.get(key, []):
        k2 = (f, round(cn))
        if k2 not in vis or 'Kardex' in src: vis[k2] = (f, cn, src)
    todas = list(vis.values())
    rec = [(f, cn, src) for f, cn, src in todas if abs((D(f) - v).days) <= 45]
    for f, cn, src in sorted(rec): ev.append({'f': f, 't': 'rec', 'x': f'{src}: {cn:,.0f} u'})
    ev.append({'f': x['venc'], 't': 'venc', 'x': f"Vence la nota · {q:,.0f} u solicitadas · {(x['recib'] or 0):,.0f} recibidas según el libro"})
    hermanas = LB.get((str(x['req']), str(x['cod']), x.get('cedis')), [])
    desde = min(D(h['venc']) for h in hermanas) - dt.timedelta(days=30) if hermanas else v
    rec_tot = sum(cn for f, cn, s in todas if D(f) >= desde)
    lib_tot = sum(h['recib'] or 0 for h in hermanas)
    falta = rec_tot - lib_tot if x.get('cedis') == 'CDPA' else 0
    # clase
    clase, mot = 'PASA', 'Sin antecedentes que liberen al proveedor: el atraso es imputable al contratista.'
    if cita:
        s_, fs, fc = D(cita['solicitadaEl']), D(cita['fechaSolicitada']), D(cita['fechaConfirmada'])
        if s_ <= v and fs <= v and ((fc and fc > v) or cita['estado'] in ('RECHAZADA', 'DIFERIDA', 'CANCELADA')):
            clase, mot = 'NO_IMPUTABLE', f"El proveedor pidió cita el {cita['solicitadaEl'][:10]} para el {cita['fechaSolicitada']} (antes del vencimiento) y la cita quedó para el {cita['fechaConfirmada'] or '—'} · {cita['estado']}."
        elif cita['estado'] in ('ASISTIO', 'ENTREGADO'):
            clase, mot = 'CONCILIAR', f"La cita del {cita['fechaConfirmada']} figura como {cita['estado']}, pero el libro sigue con saldo: verificar la recepción antes de notificar."
        elif s_ > v: mot = f"El proveedor pidió la cita el {cita['solicitadaEl'][:10]}, después del vencimiento."
        elif fs > v: mot = f"El proveedor pidió la cita a tiempo, pero para el {cita['fechaSolicitada']}, después del vencimiento."
    if clase == 'PASA' and falta >= 0.9 * (x['saldo'] or 0) > 0:
        clase, mot = 'CONCILIAR', f'Recepción registra {rec_tot:,.0f} u de este renglón y el libro reparte {lib_tot:,.0f} u entre sus notas: faltan {falta:,.0f} u en el libro, más que el saldo de esta nota. Conciliar antes de notificar.'
    pend = [c for c in ventana if c is not cita and D(c['solicitadaEl']) <= v and D(c['fechaSolicitada']) <= v and c['estado'] in ('AGENDADA', 'SOLICITADA', 'DIFERIDA', 'RECHAZADA', 'CANCELADA') and (not c['fechaConfirmada'] or D(c['fechaConfirmada']) > v)]
    if clase == 'PASA' and pend:
        c0 = pend[0]
        clase, mot = 'VERIFICAR', 'Hay una cita del renglón pedida el ' + c0['solicitadaEl'][:10] + ' para el ' + c0['fechaSolicitada'] + ' (antes del vencimiento) que CSS dejó para después o no atendió; no coincide en cantidad con esta nota: verificar si corresponde.'
    cnt[clase] += 1
    out[eid] = {'c': clase, 'm': mot, 'ev': sorted(ev, key=lambda e: (e['f'], e['t'] != 'venc'))}
meta = {'fuente': 'SIGUELO: tránsitos de OC, citas de proveedores (desde ene-2026), Recepción y Kardex 101', 'corteLibro': L.get('corte'),
        'generado': dt.datetime.now().strftime('%Y-%m-%d %H:%M'), 'conteo': dict(cnt),
        'nota': 'Las citas no traen el número de nota de entrega: se atan por orden, renglón, cantidad (±10 %) y fecha cercana al vencimiento.'}
json.dump({'_meta': meta, 'exp': out}, open('data/antecedentes.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(dict(cnt), len(out))
