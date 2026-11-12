#!/usr/bin/env python3
"""Informe ejecutivo del Expediente de Incumplimiento (DENA y Director General).

Se arma solo, con los mismos datos que el tablero:
  data/cumplimiento_entregas.json  libro de Incumplimientos de Seguimiento
  data/siscomp_cruce.json          cruce cierto con SisCOMP+ (Compras)
  data/antecedentes.json           verificación previa (citas, recepción)
  incumplimiento_eventos.json      hitos registrados con PIN (SIGUELO)

Uso: python3 scripts/informe_ejecutivo.py RUTA_EVENTOS [CARPETA_SALIDA]
Salida: incumplimiento_ejecutivo.pdf (DENA), incumplimiento_ejecutivo_DG.pdf
(Director General) e incumplimiento_ejecutivo.json (cifras para el correo).
No infiere cantidades ni montos: saldo = saldo del libro x precio del libro.
"""
import base64, re, collections as C, datetime as dt, html, json, os, sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVJ = sys.argv[1] if len(sys.argv) > 1 else ''
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(RAIZ, 'informes')
os.makedirs(OUT, exist_ok=True)

ETAPAS = [
    (1, 'Sistema', 'DINALOG', 'Nota vencida con saldo'),
    (2, 'Jefe del Depto. de Seguimiento', 'DINALOG', 'Informe de incumplimiento'),
    (3, 'Jefe del Depto. de Prórrogas y Multas', 'Compras', 'Notificación al proveedor y a la afianzadora'),
    (4, 'Jefe del Depto. de Prórrogas y Multas', 'Compras', 'Descargos o prórroga'),
    (5, 'Director de Abasto', 'DINALOG', 'Evaluación e instrucción de resolver'),
    (6, 'Coordinador Legal', 'DENA', 'Resolución administrativa y multa'),
    (7, 'Jefe del Depto. de Prórrogas y Multas', 'Compras', 'Notificación y ejecución de la fianza'),
]
PLAZOS = {1: 0, 2: 2, 3: 3, 4: 5, 5: 10, 6: None, 7: 3}
MES = 'enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre'.split()


def leer(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def habiles(a, b):
    if not a or not b or b <= a:
        return 0
    d, e, n = dt.date.fromisoformat(a), dt.date.fromisoformat(b), 0
    while d < e:
        d += dt.timedelta(days=1)
        n += d.weekday() < 5
    return n


def fecha_larga(s):
    d = dt.date.fromisoformat(s)
    return f'{d.day} de {MES[d.month - 1]} de {d.year}'


def fm(n):
    return f'B/. {n / 1e6:,.2f} M' if n >= 1e6 else f'B/. {n:,.0f}'


def corta(s, n):
    s = str(s or '')
    return s if len(s) <= n else s[:n].rsplit(' ', 1)[0].rstrip(',;') + '…'


esc = lambda s: html.escape(str(s if s is not None else ''))

# ------------------------------------------------------------------ datos
L = leer(os.path.join(RAIZ, 'data/cumplimiento_entregas.json'))
ix = {k: i for i, k in enumerate(L['cols'])}
S = leer(os.path.join(RAIZ, 'data/siscomp_cruce.json'))
A = leer(os.path.join(RAIZ, 'data/antecedentes.json')).get('exp', {})
EV = leer(EVJ).get('eventos', []) if EVJ and os.path.exists(EVJ) else []
hoy = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).date().isoformat()  # Panamá

ev = C.defaultdict(list)
for e in EV:
    if e.get('estado') != 'ANULADO':
        ev[e['exp']].append(e)
sc = {i for r in S.get('confirmados', []) for i in r['exp']}

X, vencidas, sinPrecio = [], C.Counter(), 0
for r in L['rows']:
    g = lambda k: r[ix[k]]
    venc, saldo = str(g('venc') or ''), float(g('saldo') or 0)
    if venc and venc < hoy:
        vencidas[g('estHoja') or 'SIN CLASIFICAR'] += 1
    if not venc or venc >= hoy or saldo <= 0:
        continue
    eid = 'EXP-%s-%s' % (g('req'), re.sub(r'[^0-9A-Za-z.]', '', str(g('nota'))))
    et = min(5, int(g('et') or 0))
    act = et + 2
    ini = [venc, g('fAviso') or venc, g('fNotP') or g('fAviso') or venc][min(2, et)] or venc
    for e in sorted(ev[eid], key=lambda e: e['etapa']):
        if e['etapa'] == act:
            act, ini = act + 1, e['fecha']
    if act > 7:
        continue
    p, dd = PLAZOS[act], habiles(ini, hoy)
    se = 'g' if p is None else ('v' if dd < 0.8 * p else ('a' if dd <= p else 'r'))
    an = A.get(eid)
    if act == 2 and an and an.get('c') != 'PASA':
        se = 'w'
    precio = float(g('precio') or 0)
    sinPrecio += precio == 0
    X.append(dict(id=eid, prov=g('prov') or '', cod=str(g('cod') or ''), desc=g('desc') or '', inv=g('inv') or '',
                  cedis=g('cedis') or '', venc=venc, val=saldo * precio, act=act, d=dd, p=p, se=se,
                  sc=eid in sc, dias=(dt.date.fromisoformat(hoy) - dt.date.fromisoformat(venc)).days))

N, VAL = len(X), sum(x['val'] for x in X)
porSe = C.Counter(x['se'] for x in X)
porEt = C.Counter(x['act'] for x in X)
valEt = C.Counter()
for x in X:
    valEt[x['act']] += x['val']
ver = [x for x in X if x['se'] == 'w']
pv = C.defaultdict(lambda: [0.0, 0])
for x in X:
    pv[x['prov']][0] += x['val']; pv[x['prov']][1] += 1
topP = sorted(pv.items(), key=lambda t: -t[1][0])
top5 = sum(v[0] for _, v in topP[:5]) / VAL * 100 if VAL else 0
rg = C.defaultdict(lambda: [0.0, 0, ''])
for x in X:
    k = x['cod']; rg[k][0] += x['val']; rg[k][1] += 1; rg[k][2] = x['desc']
topR = sorted(rg.items(), key=lambda t: -t[1][0])[:8]
inv = C.Counter()
for x in X:
    inv[x['inv'] or 'SIN TIPO'] += x['val']
edad = C.OrderedDict([('Hasta 30 días', 0), ('31 a 90 días', 0), ('91 a 180 días', 0), ('Más de 180 días', 0)])
edadV = C.Counter()
for x in X:
    k = list(edad)[0 if x['dias'] <= 30 else 1 if x['dias'] <= 90 else 2 if x['dias'] <= 180 else 3]
    edad[k] += 1; edadV[k] += x['val']
totV = sum(vencidas.values())
_v = min(str(r[ix['venc']]) for r in L['rows'] if r[ix['venc']] and str(r[ix['venc']]) < hoy)
VMIN = f'{MES[int(_v[5:7]) - 1]} de {_v[:4]}'
cumple = vencidas.get('CUMPLE', 0)
cnt = S['_meta'].get('conteo', {})
tot = S['_meta'].get('totales', {})
hitos = sum(len(v) for v in ev.values())
enE2 = porEt.get(2, 0)

R = dict(hoy=hoy, corteLibro=L.get('corte'), expedientes=N, saldo=round(VAL, 2), proveedores=len(pv),
         semaforo=dict(porSe), etapas={str(k): v for k, v in sorted(porEt.items())},
         verificacion=dict(n=len(ver), saldo=round(sum(x['val'] for x in ver), 2)),
         top5pct=round(top5, 1), cumplimientoATiempo=round(cumple / totV * 100, 1) if totV else None,
         notasVencidas=totV, hitosRegistrados=hitos, siscomp=dict(cerrar=cnt.get('CERRAR', 0),
         confirmados=cnt.get('CONFIRMADO', 0), revision=cnt.get('INCIERTO', 0)))

# ------------------------------------------------------------------ HTML
logo = base64.b64encode(open(os.path.join(RAIZ, 'icons/icon-192.png'), 'rb').read()).decode()
SEM = {'r': ('Vencido en su etapa', '#c83a3a', '#fbe3e3'), 'a': ('Por vencer', '#a87500', '#fff4d6'),
       'v': ('Dentro del plazo', '#2f8a3e', '#e3f4e6'), 'w': ('En verificación previa', '#5b3f8a', '#efe8f8'),
       'g': ('Sin plazo acordado', '#5f6b78', '#eef1f4')}

CSS = '''
@page{size:A4;margin:16mm 15mm 18mm}
*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:10pt;margin:0;line-height:1.38}
.pg{page-break-after:always}.pg:last-child{page-break-after:auto}
.cab{display:flex;align-items:center;gap:12px;background:#0c447c;color:#fff;border-radius:8px;padding:10px 14px}
.cab img{width:46px;height:46px;background:#fff;border-radius:50%}
.cab .s{font-size:7.5pt;letter-spacing:.3px;opacity:.85}.cab .t{font-size:15pt;font-weight:700;margin-top:1px}
.meta{display:flex;justify-content:space-between;font-size:8pt;color:#5f6b78;margin:6px 2px 10px}
h2{font-size:11.5pt;color:#0c447c;margin:14px 0 6px;border-bottom:1.5px solid #d6e2ef;padding-bottom:3px}
.kp{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:4px 0 10px}
.k{border-radius:8px;padding:9px 11px;background:#eef4fb}.k .n{font-size:19pt;font-weight:700;color:#0c447c;line-height:1.1}
.k .l{font-size:8pt;color:#374151;margin-top:2px}
.msg{background:#0c447c0d;border-left:4px solid #0c447c;padding:9px 12px;border-radius:0 8px 8px 0;font-size:10.5pt;margin:6px 0 4px}
table{border-collapse:collapse;width:100%;font-size:8.6pt}th{background:#1e5a9e;color:#fff;text-align:left;padding:5px 6px;font-weight:600}
td{padding:4.5px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top}.r{text-align:right;white-space:nowrap}
.bar{height:9px;border-radius:5px;background:#1e5a9e;display:inline-block;vertical-align:middle}
.pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:7.8pt;white-space:nowrap}
.sm{font-size:8pt;color:#5f6b78}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.flujo{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin:4px 0}
.e{border-radius:7px;padding:6px 5px;font-size:7.4pt;background:#eef4fb;min-height:88px}
.e b{display:block;font-size:12pt;color:#0c447c}.e .q{color:#5f6b78;margin-top:3px}
.e.on{background:#fbe3e3}.e.on b{color:#c83a3a}
.dec td{font-size:9pt}.dec .nn{font-size:13pt;font-weight:700;color:#0c447c;width:24px}
.nota{background:#fff8e6;border:1px solid #f2dc7a;border-radius:8px;padding:8px 11px;font-size:8.8pt;margin-top:8px}
'''


def cab(titulo, dest):
    return (f'<div class="cab"><img src="data:image/png;base64,{logo}"><div><div class="s">CAJA DE SEGURO SOCIAL · '
            f'DIRECCIÓN NACIONAL DE LOGÍSTICA (DINALOG)</div><div class="t">{titulo}</div></div></div>'
            f'<div class="meta"><span>Para: {dest}</span><span>Situación al {fecha_larga(hoy)} · libro de Seguimiento '
            f'al {fecha_larga(L["corte"])}</span></div>')


def kpis():
    k = lambda n, l, c='': f'<div class="k" {c}><div class="n">{n}</div><div class="l">{l}</div></div>'
    return ('<div class="kp">' +
            k(N, f'expedientes abiertos<br>(notas vencidas con saldo, {len(pv)} proveedores)') +
            k(fm(VAL), 'saldo no entregado<br>(saldo del libro × precio)') +
            k(porSe.get('r', 0), 'vencidos en su etapa<br>(pasaron el plazo propuesto)', 'style="background:#fbe3e3"') +
            k(len(ver), f'en verificación previa<br>{fm(sum(x["val"] for x in ver))} por conciliar', 'style="background:#efe8f8"') +
            '</div>')


def mensaje():
    return (f'<div class="msg"><b>{top5:.0f} % del saldo incumplido está en 5 proveedores.</b> '
            f'{enE2} de los {N} expedientes ({enE2 / N * 100:.0f} %) siguen en la etapa 2: todavía no tienen el '
            f'informe de incumplimiento que abre el trámite de multa y fianza. '
            f'De las {totV:,} notas vencidas desde {VMIN}, el {R["cumplimientoATiempo"]:.0f} % se entregó a tiempo '
            f'según el libro de Seguimiento.</div>')


def flujo():
    out = '<div class="flujo">'
    for n, cargo, dire, que in ETAPAS:
        c = porEt.get(n, 0)
        p = PLAZOS[n]
        rojo = sum(1 for x in X if x['act'] == n and x['se'] == 'r')
        out += (f'<div class="e{" on" if rojo else ""}"><b>{c if n > 1 else "—"}</b>{n} · {esc(que)}'
                f'<div class="q">{esc(cargo)} · {dire}<br>Plazo: {"automática" if p == 0 else ("por definir" if p is None else f"{p} días háb.")}</div></div>')
    return out + '</div><div class="sm">El número grande es cuántos expedientes esperan esa etapa hoy; en rojo, las etapas con expedientes que pasaron su plazo. Plazos: propuesta de DINALOG para validación de la DENA.</div>'


def semaforo():
    filas = ''
    for s in 'rawvg':
        if not porSe.get(s):
            continue
        n, c, f = SEM[s]
        v = sum(x['val'] for x in X if x['se'] == s)
        filas += (f'<tr><td><span class="pill" style="background:{f};color:{c}">{n}</span></td><td class="r">{porSe[s]}</td>'
                  f'<td class="r">{fm(v)}</td><td><span class="bar" style="width:{max(2, porSe[s] / N * 150):.0f}px;background:{c}"></span></td></tr>')
    return '<table><tr><th>Semáforo</th><th class="r">Expedientes</th><th class="r">Saldo</th><th></th></tr>' + filas + '</table>'


def decisiones(corto=False):
    D = [
        ('Nombrar a los responsables de cada etapa', 'Titular y suplente por cargo, con su correo. Con eso se entregan los PIN y los avisos llegan a cada persona.'),
        ('Fijar el plazo de la etapa 6 (resolución y multa)', 'Hoy no tiene plazo: el semáforo la muestra en gris.'),
        ('Activar la entrega con los siguientes oferentes cuando proceda', 'Art. 214, num. 22 y 23 de la Ley 419: decisión de la DENA caso por caso.'),
        (f'Cerrar en SisCOMP+ las {R["siscomp"]["cerrar"]} entregas ya recibidas', 'Compras las tiene en el Excel de cierre: figuran como pendientes en SisCOMP+, pero el libro las da por entregadas.'),
        ('Fijar la fecha de arranque', 'Desde ese día todo hito se registra en la plataforma; los que ya se hicieron en papel se cargan una sola vez con su documento.'),
    ]
    if corto:
        D = D[:3] + D[4:]
    return '<table class="dec">' + ''.join(f'<tr><td class="nn">{i}</td><td><b>{esc(a)}</b><br><span class="sm">{esc(b)}</span></td></tr>' for i, (a, b) in enumerate(D, 1)) + '</table>'


def pie_metodo():
    return ('<p class="sm" style="margin-top:10px">Fuente: libro de Incumplimientos del Departamento de Seguimiento, extracto de SisCOMP+ de la '
            'Dirección Nacional de Compras (solo cruces ciertos) y registros de SIGUELO (citas, recepción y hitos con PIN). '
            f'Saldo = saldo pendiente del libro × precio unitario del libro; {sinPrecio} notas sin precio cuentan B/. 0. Días hábiles de lunes a viernes. '
            'Informe generado automáticamente por la Torre de Control · DINALOG.</p>')


# Página 1 (común)
p1 = (cab('Expediente de incumplimiento de entrega · Informe ejecutivo', '{DEST}') + kpis() + mensaje() +
      '<h2>Dónde está detenido el proceso</h2>' + flujo() +
      '<div class="two" style="margin-top:8px"><div><h2 style="margin-top:4px">Semáforo de plazos</h2>' + semaforo() + '</div><div>'
      '<h2 style="margin-top:4px">Antigüedad del atraso</h2><table><tr><th>Desde el vencimiento</th><th class="r">Exp.</th><th class="r">Saldo</th></tr>' +
      ''.join(f'<tr><td>{k}</td><td class="r">{v}</td><td class="r">{fm(edadV[k])}</td></tr>' for k, v in edad.items()) + '</table></div></div>')

# Página 2
filasP = ''.join(
    f'<tr><td>{i}</td><td>{esc(k)}</td><td class="r">{v[1]}</td><td class="r">{fm(v[0])}</td><td class="r">{v[0] / VAL * 100:.1f} %</td>'
    f'<td><span class="bar" style="width:{v[0] / topP[0][1][0] * 110:.0f}px"></span></td></tr>' for i, (k, v) in enumerate(topP[:10], 1))
filasR = ''.join(f'<tr><td>{esc(k)}</td><td>{esc(corta(v[2], 60))}</td><td class="r">{v[1]}</td><td class="r">{fm(v[0])}</td></tr>' for k, v in topR)
filasI = ''.join(f'<tr><td>{esc(k.title())}</td><td class="r">{fm(v)}</td><td class="r">{v / VAL * 100:.0f} %</td></tr>' for k, v in inv.most_common())
p2 = (cab('Dónde está el incumplimiento', '{DEST}') +
      '<h2>Los 10 proveedores con más saldo no entregado</h2><table><tr><th>#</th><th>Proveedor</th><th class="r">Exp.</th><th class="r">Saldo</th><th class="r">Del total</th><th></th></tr>' + filasP + '</table>'
      f'<p class="sm">Los 10 suman {sum(v[0] for _, v in topP[:10]) / VAL * 100:.0f} % del saldo; los otros {len(topP) - 10} proveedores, el resto.</p>'
      '<div class="two"><div><h2>Renglones con más saldo</h2><table><tr><th>Código</th><th>Descripción</th><th class="r">Exp.</th><th class="r">Saldo</th></tr>' + filasR + '</table></div>'
      '<div><h2>Por tipo de inventario</h2><table><tr><th>Tipo</th><th class="r">Saldo</th><th class="r">%</th></tr>' + filasI + '</table>'
      '<h2>Antes de multar: verificación previa</h2>'
      f'<p style="margin:0">{len(ver)} expedientes tienen señales de que el atraso pudo no ser del proveedor (cita confirmada, recepción registrada o saldo ya recibido en el CEDIS). '
      f'Suman <b>{fm(sum(x["val"] for x in ver))}</b>. Seguimiento los concilia antes de emitir su informe, para no multar sobre un dato equivocado.</p></div></div>')

# Página 3
p3 = (cab('Qué se está haciendo y qué se necesita', '{DEST}') +
      '<h2>El circuito ya está listo</h2><table>'
      '<tr><td style="width:30%"><b>Ficha única por expediente</b></td><td>Cada nota vencida con saldo abre su expediente. Cada responsable registra su hito con su PIN y adjunta el documento firmado (Ley 419, arts. 228 a 233).</td></tr>'
      '<tr><td><b>Avisos automáticos</b></td><td>Al registrar una etapa, el cargo que sigue recibe un correo con el plazo y la fecha límite. Cada mañana, cada jefe recibe lo que le toca; si un plazo vence, se escala al director de esa dirección.</td></tr>'
      '<tr><td><b>Verificación previa</b></td><td>Antes del informe de incumplimiento, el sistema revisa citas, recepción y Kardex para separar lo imputable al proveedor de lo que hay que conciliar.</td></tr>'
      f'<tr><td><b>Dato depurado con Compras</b></td><td>Del extracto de SisCOMP+ solo entra lo que cruza con certeza: {R["siscomp"]["confirmados"]} entregas confirmadas y {R["siscomp"]["cerrar"]} por cerrar. Las {R["siscomp"]["revision"]:,} filas con dudas volvieron a Compras con un informe de aclaración.</td></tr></table>' +
      ('<div class="nota"><b>Sobre la cifra de SisCOMP+.</b> El extracto suma ' + fm(tot['saldoSisCOMP']).replace(' M', ' millones') +
       f' de saldo pendiente, pero {tot["filasInfladas"]} filas traen el precio leído sin decimales. Corregido con el precio del propio extracto, el saldo es <b>{fm(tot["saldoCorregido"])}</b>. '
       'Se recomienda no citar el total de SisCOMP+ sin esta corrección.</div>' if tot else '') +
      '<h2>Decisiones que se necesitan de la DENA</h2>' + decisiones() + pie_metodo())

# Director General: una página
pDG = (cab('Incumplimiento de entregas de proveedores · Resumen', '{DEST}') + kpis() + mensaje() +
       '<h2>Dónde está detenido el proceso</h2>' + flujo() +
       '<div class="two" style="margin-top:6px"><div><h2 style="margin-top:4px">Los 5 proveedores con más saldo</h2><table><tr><th>Proveedor</th><th class="r">Saldo</th></tr>' +
       ''.join(f'<tr><td>{esc(k)}</td><td class="r">{fm(v[0])}</td></tr>' for k, v in topP[:5]) + '</table></div>'
       '<div><h2 style="margin-top:4px">Lo que se está haciendo</h2><p style="margin:0;font-size:9pt">Expediente digital por nota vencida, con hitos firmados por PIN, avisos automáticos a cada responsable y '
       'escalamiento cuando un plazo vence. Los datos de Compras y Logística se depuraron juntos: solo entra lo cierto.</p></div></div>'
       '<h2>Decisiones en curso (DENA)</h2>' + decisiones(corto=True) + pie_metodo())


def doc(pags, dest):
    cuerpo = ''.join(f'<section class="pg">{p.replace("{DEST}", dest)}</section>' for p in pags)
    return f'<!doctype html><html lang="es"><head><meta charset="utf-8"><style>{CSS}</style></head><body>{cuerpo}</body></html>'


PIE = ('<div style="font-size:7pt;color:#6b7280;width:100%;padding:0 15mm;display:flex;justify-content:space-between;font-family:Arial">'
       '<span>DINALOG · Torre de Control · Expediente de Incumplimiento</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>')

if not os.environ.get('SOLO_DATOS'):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page()
        for nombre, pags, dest in [('incumplimiento_ejecutivo.pdf', [p1, p2, p3], 'Directora Ejecutiva Nacional de Administración (DENA)'),
                                   ('incumplimiento_ejecutivo_DG.pdf', [pDG], 'Director General · por conducto de la DENA')]:
            h = doc(pags, dest)
            open(os.path.join(OUT, nombre.replace('.pdf', '.html')), 'w', encoding='utf-8').write(h)
            pg.set_content(h, wait_until='load')
            pg.pdf(path=os.path.join(OUT, nombre), format='A4', print_background=True, display_header_footer=True,
                   header_template='<span></span>', footer_template=PIE, margin=dict(top='14mm', bottom='16mm', left='15mm', right='15mm'))
        b.close()

    json.dump(R, open(os.path.join(OUT, 'incumplimiento_ejecutivo.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(R, ensure_ascii=False))
