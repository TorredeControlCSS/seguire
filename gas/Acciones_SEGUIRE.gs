/**
 * SEGUIRE · Bitácora de acciones por incumplimiento
 * Instalar en un proyecto de Apps Script ligado a una hoja de cálculo, publicar como
 * Aplicación web (ejecutar como: yo · acceso: cualquier usuario) y pegar la URL en
 * WEBAPP_ACCIONES dentro de index.html.
 */
var HOJA_ACCIONES = 'ACCIONES';
var COLS_ACCIONES = ['creado','fecha','cod','tipo','monto','resp','nota'];

function hojaAcciones_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(HOJA_ACCIONES);
  if (!sh) { sh = ss.insertSheet(HOJA_ACCIONES); sh.appendRow(COLS_ACCIONES); sh.setFrozenRows(1); }
  return sh;
}

function doGet(e) {
  var sh = hojaAcciones_(), v = sh.getDataRange().getValues(), h = v.shift();
  var acciones = v.map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i] instanceof Date ? Utilities.formatDate(r[i], 'America/Panama', 'yyyy-MM-dd') : r[i]; }); return o; });
  return ContentService.createTextOutput(JSON.stringify({ ok: true, acciones: acciones })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var a = JSON.parse(e.postData.contents || '{}');
  if (a.accion !== 'registrar' || !a.cod || !a.tipo) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'datos incompletos' })).setMimeType(ContentService.MimeType.JSON);
  }
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { hojaAcciones_().appendRow(COLS_ACCIONES.map(function (k) { return a[k] == null ? '' : a[k]; })); }
  finally { lock.releaseLock(); }
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}
