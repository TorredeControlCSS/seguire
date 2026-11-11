/* ══════════════════════════════════════════════════════════════════════════
 *  TRANSITOS_PLANIFICADOR · proyecto SÍGUELO (libro BASE DE DATOS DE CITAS)
 *  11-nov-2026 · Torre de Control
 *
 *  Mantiene el PLANIFICADOR de TRANSITOS_OC al día con el Reporte_Abastecimiento
 *  (la asignación de renglones que publica Inventario Consolidado en
 *  Curvas_de_Inventario/kpi_inventario_renglones.json).
 *
 *  1. CAMBIO DE PLANIFICADOR DEL RENGLÓN
 *     Cuando el Reporte_Abastecimiento pasa un renglón de un planificador a otro,
 *     los tránsitos ABIERTOS (SALDO > 0) de ese renglón que estaban a nombre del
 *     planificador anterior pasan al nuevo. Los cerrados se quedan con quien los
 *     gestionó. Si el tránsito lo cargó otra persona (p. ej. alguien que sube
 *     documentos de renglones ajenos), no se toca: solo se mueve lo que era del
 *     planificador anterior.
 *     Para saber qué cambió se guarda una foto de la asignación en la hoja
 *     TRANSITOS_ANALISTA_FOTO (se crea sola). En la primera corrida no hay foto:
 *     se usa TP.SEMILLA (el cambio del 6-nov: los renglones que hoy son de Elias
 *     Espinosa eran de Jenny López y Braulio Serrano).
 *
 *  2. UN SOLO NOMBRE POR PERSONA
 *     «Selene itzel Fernandez vega» y «Selene Fernández» son la misma persona:
 *     todas sus filas quedan con la forma que más se usa en TRANSITOS_OC.
 *     Los nombres mal escritos se corrigen con TP.CORRIGE (p. ej. Espinosa → Espinoza).
 *
 *  Cada cambio queda en TRANSITOS_CAMBIOS (CAMPO = PLANIFICADOR), con ANTES,
 *  DESPUES y POR. Lee las columnas por nombre. No usa LockService: escribe
 *  celdas puntuales y vuelve a comprobar el ID de cada fila antes de escribir.
 *  No envía correos.
 *
 *  INSTALACIÓN (una vez)
 *   1. Crear este archivo en el proyecto SÍGUELO y pegar todo.
 *   2. Ejecutar tpSimular()  → solo escribe en el registro lo que cambiaría.
 *   3. Ejecutar tpAplicar()  → aplica y deja la foto.
 *   4. En TRANSITOS_EVIDENCIA, dentro de tevPublicar_(forzar), justo ANTES de
 *        var obj = tevConstruir_(); ...
 *      agregar esta línea:
 *        try { tpAplicar_(); } catch (eTP) { Logger.log('tpAplicar_: ' + eTP); }
 *      Así corre sola cada vez que se publica la evidencia (varias veces al día,
 *      con las cargas del Kardex y de saldos). Si falla, la publicación sigue.
 * ══════════════════════════════════════════════════════════════════════════ */

var TP = {
  URL_ASIGNACION: 'https://torrecontrolcss.org/Curvas_de_Inventario/kpi_inventario_renglones.json',
  HOJA_FOTO: 'TRANSITOS_ANALISTA_FOTO',
  HOJA_CAMBIOS: 'TRANSITOS_CAMBIOS',
  POR_CAMBIO: 'Torre de Control · cambio de planificador del renglón (Reporte_Abastecimiento)',
  POR_NOMBRE: 'Torre de Control · un solo nombre por persona',
  // Primera corrida (sin foto): iniciales nuevas → nombres de quienes tenían esos renglones antes.
  SEMILLA: { 'EE': ['Jenny López', 'Braulio Serrano'] },
  // Nombres mal escritos → forma correcta. Se aplica en cada corrida, también a lo que se cargue después.
  // 11-nov-2026: el apellido es Espinoza (confirmado por la Jefatura: eliespinoza@css.gob.pa).
  CORRIGE: { 'Elias Espinosa': 'Elias Espinoza' }
};

function tpSimular() { var r = tpEjecutar_(false); Logger.log(JSON.stringify(r, null, 1)); return r; }
function tpAplicar() { var r = tpEjecutar_(true); Logger.log(JSON.stringify(r, null, 1)); return r; }
/* Para el enganche en tevPublicar_. Nunca lanza. */
function tpAplicar_() {
  try { var r = tpEjecutar_(true); if (r && (r.reasignadas || r.unificadas)) Logger.log('TRANSITOS_PLANIFICADOR: ' + r.reasignadas + ' reasignadas · ' + r.unificadas + ' nombres unificados'); return r; }
  catch (e) { Logger.log('tpAplicar_ ERROR: ' + e); return { success: false, error: String(e) }; }
}

/* ── nombres ── */
function tpTok_(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z ]/g, ' ')
    .split(/\s+/).filter(function (w) { return w && ['DE', 'LA', 'DEL', 'LOS'].indexOf(w) < 0; });
}
/* Misma regla que el panel (trEsDe): mismo nombre de pila y el resto de una forma
   está contenido en la otra (acepta iniciales: «Nohelia S.» = «Nohelia Sánchez»). */
function tpEsDe_(a, b) {
  var A = tpTok_(a), B = tpTok_(b);
  if (!A.length || !B.length || A[0] !== B[0]) return false;
  return A.slice(1).every(function (w) { return B.some(function (u) { return u === w || (u.length === 1 && w.charAt(0) === u) || (w.length === 1 && u.charAt(0) === w); }); });
}
function tpMisma_(a, b) { return tpEsDe_(a, b) || tpEsDe_(b, a); }

function tpEjecutar_(escribir) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(TR_OC_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: false, error: 'No hay tránsitos.' };
  var idx = tr_colIndex_(sh);
  ['ID', 'COD_ABASTO', 'PLANIFICADOR', 'SALDO', 'N_DOCUMENTO'].forEach(function (c) { if (idx[c] == null) throw new Error('Falta la columna ' + c + ' en TRANSITOS_OC.'); });

  // Asignación vigente
  var resp = UrlFetchApp.fetch(TP.URL_ASIGNACION + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { success: false, error: 'No se pudo leer la asignación: HTTP ' + resp.getResponseCode() };
  var K = JSON.parse(resp.getContentText()), col = K.columnas || [];
  var iC = col.indexOf('codigo'), iA = col.indexOf('analista');
  if (iC < 0 || iA < 0 || !K.renglones) return { success: false, error: 'kpi_inventario_renglones.json no trae codigo/analista.' };
  var NOM = K.analistas || {}, cur = {};
  K.renglones.forEach(function (r) { var c = String(r[iC] || '').trim(), a = String(r[iA] || '').trim(); if (c && a && a !== 'SIN ASIGNAR' && NOM[a]) cur[c] = a; });
  if (Object.keys(cur).length < 200) return { success: false, error: 'La asignación trae muy pocos renglones (' + Object.keys(cur).length + '); no se toca nada.' };

  var n = sh.getLastRow() - 1, vals = sh.getRange(2, 1, n, sh.getLastColumn()).getValues();

  // Forma preferida de cada persona = la más usada en TRANSITOS_OC
  var cuenta = {};
  vals.forEach(function (r) { var p = String(r[idx['PLANIFICADOR']] || '').trim(); if (p) cuenta[p] = (cuenta[p] || 0) + 1; });
  var formas = Object.keys(cuenta).sort(function (a, b) { return cuenta[b] - cuenta[a]; });
  var CORR = {}; Object.keys(TP.CORRIGE || {}).forEach(function (k) { CORR[tpTok_(k).join(' ')] = TP.CORRIGE[k]; });
  function corr(nombre) { return CORR[tpTok_(nombre).join(' ')] || nombre; }
  formas = formas.map(corr).filter(function (x, i, a) { return a.indexOf(x) === i; });
  function canon(nombre) { nombre = corr(nombre); var f = formas.filter(function (x) { return tpMisma_(x, nombre); })[0]; return f || nombre; }

  // Foto anterior
  var hf = ss.getSheetByName(TP.HOJA_FOTO), prev = null;
  if (hf && hf.getLastRow() > 1) {
    prev = {};
    hf.getRange(2, 1, hf.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0]) prev[String(r[0]).trim()] = String(r[1] || '').trim(); });
  }

  // Qué renglones cambiaron: cod → { antes: [nombres], despues: nombre }
  var cambio = {};
  Object.keys(cur).forEach(function (c) {
    var ahora = cur[c];
    if (prev) {
      var antes = prev[c];
      if (antes && antes !== ahora && NOM[antes]) cambio[c] = { antes: [NOM[antes]], despues: NOM[ahora] };
    } else if (TP.SEMILLA[ahora]) {
      cambio[c] = { antes: TP.SEMILLA[ahora], despues: NOM[ahora] };
    }
  });

  var planes = [], porDoc = {};
  vals.forEach(function (r, i) {
    var id = String(r[idx['ID']] || ''), p = String(r[idx['PLANIFICADOR']] || '').trim(); if (!id || !p) return;
    var c = String(r[idx['COD_ABASTO']] || '').trim(), saldo = Number(r[idx['SALDO']]) || 0, nuevo = null, motivo = null;
    var cb = cambio[c];
    if (cb && saldo > 0 && cb.antes.some(function (a) { return tpMisma_(a, p); }) && !tpMisma_(cb.despues, p)) { nuevo = canon(cb.despues); motivo = 'CAMBIO'; }
    else { var k = canon(p); if (k !== p) { nuevo = k; motivo = 'NOMBRE'; } }
    if (!nuevo || nuevo === p) return;
    planes.push({ fila: i + 2, id: id, antes: p, despues: nuevo, motivo: motivo, doc: String(r[idx['N_DOCUMENTO']] || ''), cod: c });
  });

  var reasignadas = 0, unificadas = 0, saltadas = 0;
  if (escribir && planes.length) {
    var colId = idx['ID'] + 1, colP = idx['PLANIFICADOR'] + 1;
    planes.forEach(function (x) {
      if (String(sh.getRange(x.fila, colId).getValue()) !== x.id) { saltadas++; x.saltada = true; return; }   // la fila cambió: no se toca
      sh.getRange(x.fila, colP).setValue(x.despues);
      if (x.motivo === 'CAMBIO') reasignadas++; else unificadas++;
      var k = x.doc + '|' + x.antes + '|' + x.despues + '|' + x.motivo;
      porDoc[k] = porDoc[k] || { doc: x.doc, antes: x.antes, despues: x.despues, motivo: x.motivo, filas: 0 }; porDoc[k].filas++;
    });
    var hc = ss.getSheetByName(TP.HOJA_CAMBIOS);
    if (!hc) { hc = ss.insertSheet(TP.HOJA_CAMBIOS); hc.appendRow(['FECHA', 'N_DOCUMENTO', 'CAMPO', 'ANTES', 'DESPUES', 'FILAS', 'POR']); hc.setFrozenRows(1); }
    var ahora = new Date(), filasLog = Object.keys(porDoc).map(function (k) { var d = porDoc[k];
      return [ahora, d.doc, 'PLANIFICADOR', d.antes, d.despues, d.filas, d.motivo === 'CAMBIO' ? TP.POR_CAMBIO : TP.POR_NOMBRE]; });
    if (filasLog.length) hc.getRange(hc.getLastRow() + 1, 1, filasLog.length, 7).setValues(filasLog);
    try { if (typeof bumpDataVersion_ === 'function') bumpDataVersion_(); } catch (eV) {}
  } else {
    planes.forEach(function (x) { if (x.motivo === 'CAMBIO') reasignadas++; else unificadas++; });
  }

  // Foto nueva (solo al escribir, y solo si la lectura fue completa)
  if (escribir) {
    if (!hf) { hf = ss.insertSheet(TP.HOJA_FOTO); }
    var foto = Object.keys(cur).sort().map(function (c) { return [c, cur[c], NOM[cur[c]] || '']; });
    hf.clearContents();
    hf.getRange(1, 1, 1, 4).setValues([['COD_ABASTO', 'INICIALES', 'NOMBRE', 'FOTO_' + (K.generado || '')]]);
    hf.getRange(2, 1, foto.length, 3).setNumberFormat('@').setValues(foto);
  }

  var resumen = {};
  planes.forEach(function (x) { var k = x.motivo + ': ' + x.antes + ' → ' + x.despues; resumen[k] = (resumen[k] || 0) + 1; });
  return { success: true, escribio: !!escribir, primeraCorrida: !prev, asignacion: K.generado, renglonesCambiados: Object.keys(cambio).length,
           reasignadas: reasignadas, unificadas: unificadas, saltadas: saltadas, detalle: resumen };
}
