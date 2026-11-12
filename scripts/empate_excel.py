#!/usr/bin/env python3
"""Excel de empate (carga inicial) del Expediente de Incumplimiento.

Una hoja por cargo con TODOS los expedientes abiertos y, por cada etapa que
ese cargo registra, cuatro columnas: si ya se hizo en papel, la fecha, el
número del documento y el enlace al PDF firmado. La fila 5 lleva los códigos
que lee incCargaInicial() en el backend (E2_HECHO, E2_FECHA, E2_DOC, E2_PDF...).

Uso: python3 scripts/empate_excel.py RUTA_EVENTOS SALIDA.xlsx
"""
import os, runpy, sys, datetime as dt
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule
from openpyxl.utils import get_column_letter as L

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ['SOLO_DATOS'] = '1'
sys.argv = [sys.argv[0], sys.argv[1], '/tmp/claude-0/_ej'] + sys.argv[2:]
G = runpy.run_path(os.path.join(RAIZ, 'scripts/informe_ejecutivo.py'))
X, ETAPAS = G['X'], G['ETAPAS']
fd = lambda s: '/'.join(reversed(s.split('-')))
hoy, corte = fd(G['hoy']), fd(G['L']['corte'])
SAL = sys.argv[3]

CARGOS = [('Seguimiento', 'Jefe del Departamento de Seguimiento', [2]),
          ('Prorrogas y Multas', 'Jefe del Departamento de Prórrogas y Multas', [3, 4, 7]),
          ('Director de Abasto', 'Director de Abasto', [5]),
          ('Coordinador Legal', 'Coordinador Legal (DENA)', [6])]
AZ, AZ2, GR = '0C447C', '1E5A9E', 'F2F4F7'
F = lambda c: PatternFill('solid', fgColor=c)
fino = Side(style='thin', color='D0D7E2')
B = Border(left=fino, right=fino, top=fino, bottom=fino)
FN = 'Arial'
COLOR_ET = {2: 'DCEBFA', 3: 'FDE7CF', 4: 'FFF6CC', 5: 'E3F4E6', 6: 'EFE8F8', 7: 'FDE2E4'}

wb = Workbook()
# ---------------------------------------------------------------- instrucciones
ws = wb.active; ws.title = 'Cómo llenar'
ws.sheet_view.showGridLines = False
ws.column_dimensions['A'].width = 3; ws.column_dimensions['B'].width = 30; ws.column_dimensions['C'].width = 95
ws['B2'] = 'EMPATE DEL EXPEDIENTE DE INCUMPLIMIENTO · carga inicial'; ws['B2'].font = Font(FN, 16, bold=True, color=AZ)
ws['B3'] = f'Caja de Seguro Social · DINALOG · expedientes abiertos al {hoy} (libro de Seguimiento al {corte})'; ws['B3'].font = Font(FN, 10, color='5F6B78')
filas = [
    ('Para qué es', 'Antes de usar la plataforma, cada expediente debe quedar en la etapa en que realmente está. Lo que ya se hizo en papel se declara aquí una sola vez, con su documento, y la Torre de Control lo carga en bloque.'),
    ('Quién llena', 'Cada jefe llena SOLO la hoja de su cargo: Seguimiento (etapa 2), Prórrogas y Multas (etapas 3, 4 y 7), Director de Abasto (etapa 5) y Coordinador Legal (etapa 6).'),
    ('Qué llenar', 'Solo las celdas amarillas. «¿Se hizo?»: SÍ o NO de la lista. Si es SÍ: la fecha del documento, su número (nota, informe o resolución) y el enlace al PDF firmado en Drive o el nombre del archivo que envía con el Excel.'),
    ('Si no se hizo', 'Deje NO o vacío. El expediente arrancará en la plataforma esperando esa etapa, con su plazo contando desde la fecha de arranque.'),
    ('YA CONSTA', 'Las celdas grises ya están registradas (por el libro de Seguimiento o por la plataforma). No hay que llenarlas.'),
    ('Orden de las etapas', 'Una etapa no puede declararse hecha si la anterior no lo está, y su fecha no puede ser anterior a la de la etapa previa. La hoja marca en rojo la fila con ese problema.'),
    ('Ejemplo', 'EXP-1001027232-1831 · E2 ¿Se hizo? = SÍ · Fecha = 15/10/2026 · Documento = DINALOG-SEG-0412-2026 · PDF = https://drive.google.com/… (o Informe_0412.pdf)'),
    ('Entrega', 'Devuelva este Excel con los PDF a la Torre de Control antes de la fecha de arranque. Después de esa fecha, todo hito se registra en la plataforma con su PIN.'),
]
for i, (a, b) in enumerate(filas, 5):
    ws.cell(i, 2, a).font = Font(FN, 10, bold=True, color=AZ)
    c = ws.cell(i, 3, b); c.font = Font(FN, 10); c.alignment = Alignment(wrap_text=True, vertical='top')
    ws.cell(i, 2).alignment = Alignment(vertical='top'); ws.row_dimensions[i].height = 42
ws.cell(14, 2, 'Leyenda').font = Font(FN, 10, bold=True, color=AZ)
for j, (t, c) in enumerate([('Celda para llenar', 'FFF2B3'), ('YA CONSTA (no llenar)', 'E5E7EB'), ('Problema de orden o fecha', 'FBE3E3')]):
    x = ws.cell(15 + j, 2, t); x.fill = F(c); x.font = Font(FN, 10); x.border = B

# ---------------------------------------------------------------- hojas por cargo
BASE = [('EXPEDIENTE', 'Expediente', 22), ('OC', 'Requisición / OC', 13), ('PROVEEDOR', 'Proveedor', 32), ('RENGLON', 'Renglón', 40),
        ('SALDO', 'Saldo B/.', 13), ('VENCE', 'Vence la nota', 12), ('ETAPA_HOY', 'Etapa en la plataforma hoy', 30)]
CAMPOS = [('HECHO', '¿Se hizo?', 10), ('FECHA', 'Fecha', 12), ('DOC', 'No. de documento', 20), ('PDF', 'PDF firmado (enlace o archivo)', 30)]
amar, gris, rojo = F('FFF2B3'), F('E5E7EB'), F('FBE3E3')
Xo = sorted(X, key=lambda x: (x['act'], -x['val']))
for hoja, cargo, ets in CARGOS:
    s = wb.create_sheet(hoja); s.sheet_view.showGridLines = False; s.freeze_panes = 'D6'
    s['A1'] = f'{cargo} · etapa{"s" if len(ets) > 1 else ""} {", ".join(map(str, ets))}'; s['A1'].font = Font(FN, 14, bold=True, color=AZ)
    s['A2'] = f'Expedientes abiertos al {hoy}. Llene solo las celdas amarillas. Instrucciones en la hoja «Cómo llenar».'; s['A2'].font = Font(FN, 9, color='5F6B78')
    cols = list(BASE)
    for e in ets:
        for k, t, w in CAMPOS:
            cols.append((f'E{e}_{k}', t, w))
    # fila 3: grupo por etapa · fila 4: título · fila 5: código para la carga
    for j, (k, t, w) in enumerate(cols, 1):
        s.column_dimensions[L(j)].width = w
        c = s.cell(4, j, t); c.font = Font(FN, 9, bold=True, color='FFFFFF'); c.fill = F(AZ2); c.alignment = Alignment(wrap_text=True, vertical='center'); c.border = B
        c = s.cell(5, j, k); c.font = Font(FN, 7, color='8A94A3'); c.fill = F(GR); c.border = B
    s.row_dimensions[4].height = 30
    for i, e in enumerate(ets):
        j0 = len(BASE) + 1 + i * 4
        s.merge_cells(start_row=3, start_column=j0, end_row=3, end_column=j0 + 3)
        c = s.cell(3, j0, f'Etapa {e} · {ETAPAS[e - 1][3]}'); c.font = Font(FN, 9, bold=True, color=AZ); c.fill = F(COLOR_ET[e]); c.alignment = Alignment(horizontal='center')
    dv = DataValidation(type='list', formula1='"SÍ,NO"', allow_blank=True, showErrorMessage=True, errorTitle='Valor no válido', error='Elija SÍ o NO.')
    dvf = DataValidation(type='date', operator='between', formula1='DATE(2024,1,1)', formula2='TODAY()', allow_blank=True, showErrorMessage=True,
                         errorTitle='Fecha no válida', error='Ponga una fecha entre 2024 y hoy, como 15/10/2026.')
    s.add_data_validation(dv); s.add_data_validation(dvf)
    r = 6
    for x in Xo:
        et = ETAPAS[x['act'] - 1]
        vals = [x['id'], x['id'].split('-')[1], x['prov'], f"{x['cod']} · {x['desc']}", round(x['val'], 2), dt.date.fromisoformat(x['venc']), f"{x['act']} · {et[3]}"]
        for j, v in enumerate(vals, 1):
            c = s.cell(r, j, v); c.font = Font(FN, 9); c.border = B
        s.cell(r, 5).number_format = '#,##0.00'; s.cell(r, 6).number_format = 'DD/MM/YYYY'
        for i, e in enumerate(ets):
            j0 = len(BASE) + 1 + i * 4
            consta = x['act'] > e
            for q in range(4):
                c = s.cell(r, j0 + q); c.border = B; c.font = Font(FN, 9)
                if consta:
                    c.fill = gris
                    if q == 0: c.value = 'YA CONSTA'
                else:
                    c.fill = amar
            if not consta:
                dv.add(s.cell(r, j0)); dvf.add(s.cell(r, j0 + 1))
                s.cell(r, j0 + 1).number_format = 'DD/MM/YYYY'
        r += 1
    last = r - 1
    # Reglas de orden dentro de la hoja: SÍ en una etapa exige la anterior hecha (o que conste) y fecha no anterior
    for i in range(1, len(ets)):
        jp, jc = len(BASE) + 1 + (i - 1) * 4, len(BASE) + 1 + i * 4
        if ets[i] != ets[i - 1] + 1:
            continue
        P, Pf, C_, Cf = L(jp), L(jp + 1), L(jc), L(jc + 1)
        f = f'AND(${C_}6="SÍ",OR(AND(${P}6<>"SÍ",${P}6<>"YA CONSTA"),AND(ISNUMBER(${Pf}6),ISNUMBER(${Cf}6),${Cf}6<${Pf}6)))'
        s.conditional_formatting.add(f'{C_}6:{L(jc + 3)}{last}', FormulaRule(formula=[f], fill=rojo))
    # SÍ sin fecha o sin documento
    for i in range(len(ets)):
        j0 = len(BASE) + 1 + i * 4
        H, Fc, D = L(j0), L(j0 + 1), L(j0 + 2)
        s.conditional_formatting.add(f'{Fc}6:{D}{last}', FormulaRule(formula=[f'AND(${H}6="SÍ",{Fc}6="")'], fill=rojo))
    s.auto_filter.ref = f'A5:{L(len(cols))}{last}'

# ---------------------------------------------------------------- resumen
rs = wb.create_sheet('Resumen', 1); rs.sheet_view.showGridLines = False
rs['B2'] = 'Avance del empate'; rs['B2'].font = Font(FN, 14, bold=True, color=AZ)
rs['B3'] = 'Se actualiza solo a medida que cada jefe llena su hoja.'; rs['B3'].font = Font(FN, 9, color='5F6B78')
hdr = ['Etapa', 'Cargo', 'Hoja', 'Ya constan', 'Declaradas hechas', 'Pendientes de declarar', 'Con problema de fecha']
for j, h in enumerate(hdr, 2):
    c = rs.cell(5, j, h); c.font = Font(FN, 9, bold=True, color='FFFFFF'); c.fill = F(AZ2); c.border = B; c.alignment = Alignment(wrap_text=True)
for w, col in zip([8, 40, 20, 12, 14, 14, 14], 'BCDEFGH'):
    rs.column_dimensions[col].width = w
r = 6
for hoja, cargo, ets in CARGOS:
    for i, e in enumerate(ets):
        col = L(len(BASE) + 1 + i * 4); colF = L(len(BASE) + 2 + i * 4)
        rng, rngF = f"'{hoja}'!{col}6:{col}{5 + len(X)}", f"'{hoja}'!{colF}6:{colF}{5 + len(X)}"
        vals = [e, cargo, hoja, f'=COUNTIF({rng},"YA CONSTA")', f'=COUNTIF({rng},"SÍ")',
                f'={len(X)}-E{r}-F{r}', f'=COUNTIFS({rng},"SÍ",{rngF},"")']
        for j, v in enumerate(vals, 2):
            c = rs.cell(r, j, v); c.font = Font(FN, 9); c.border = B
        rs.cell(r, 2).fill = F(COLOR_ET[e])
        r += 1
rs.cell(r + 1, 2, f'Total de expedientes abiertos: {len(X)}. «Con problema de fecha» = marcadas SÍ sin fecha.').font = Font(FN, 9, italic=True, color='5F6B78')

wb.save(SAL)
print(SAL, len(X))
