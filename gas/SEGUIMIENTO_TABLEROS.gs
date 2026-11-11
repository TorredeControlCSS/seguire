/* ============================================================================
 *  SEGUIMIENTO_TABLEROS.gs  ·  Torre de Control  ·  10-nov-2026
 *  Proyecto: SIGUELO Backend (BASE DE DATOS DE CITAS)
 *
 *  QUE HACE
 *  Publica los dos tableros de Seguimiento de compras que se alimentan desde
 *  la Ventanilla Unica (cargar_reportes.html):
 *    1. Consolidado de Suministros de Planificacion  -> seguire/data/consolidado.json
 *       (lo lee el tablero SEGUIRE, index.html)
 *    2. Libro de Incumplimientos de Seguimiento      -> seguire/data/cumplimiento_entregas.json
 *       (lo lee el tablero Cumplimiento de Entregas, cumplimiento.html)
 *  y envia el correo diario de Cumplimiento de Entregas a las jefaturas.
 *
 *  DE DONDE SALEN LOS DATOS
 *  INGESTA_PRODUCTIVIDAD guarda cada carga en la carpeta raiz de insumos:
 *    07_CONSOLIDADO/AAAA-MM/07_CONSOLIDADO_AAAA-MM-DD.xlsx
 *    08_INCUMPLIMIENTOS/AAAA-MM/08_INCUMPLIMIENTOS_AAAA-MM-DD.xlsx
 *  Se toma el archivo de fecha mas reciente (y su version _vN mas alta).
 *  El libro se lee tal como lo guardo Excel (valores en cache): no se
 *  convierte a Google Sheets, porque la conversion recalcula las formulas y
 *  los vinculos externos rotos del libro quedarian en #REF!.
 *
 *  COMO SE DISPARA
 *  La tarjeta de la Ventanilla Unica llama, despues de cargar el archivo,
 *    ?action=segPublicar&tablero=cons   o   &tablero=inc
 *  (gancho segRuta_ en doGet de Codigo.gs). Se agenda una ejecucion de un solo
 *  uso 30 s despues y la tarjeta confirma contra el sello _meta.generado del
 *  JSON publicado, igual que Entradas.
 *
 *  CORREO DIARIO (Cumplimiento de Entregas)
 *  Destinatarios y switches en BACK_END_CALCULADORA_UE, hoja CONFIG_ALERTAS:
 *    INCUMP_ACTIVO   SI / NO
 *    INCUMP_TO       correos separados por coma
 *    INCUMP_CC       correos separados por coma
 *    INCUMP_PRUEBA_A si tiene valor, TODO va solo a ese correo
 *    INCUMP_DIAS     L-V, L-S, DIARIO o L,M,X,J,V,S,D
 *
 *  FUNCIONES PARA EJECUTAR DESDE EL EDITOR
 *    segDiagnostico            revisa carpetas, archivo vigente, GitHub y CONFIG_ALERTAS
 *    segPublicarAhoraConsolidado / segPublicarAhoraIncumplimientos   publicacion manual
 *    segCrearConfigAlertas     agrega las filas INCUMP_* que falten (no toca las demas)
 *    segInstalarCorreoDiario   crea el activador diario (una sola vez)
 *    segIncEnviarmePrueba      el correo completo SOLO a quien ejecuta (o a INCUMP_PRUEBA_A)
 *    segIncEnviarAhora         envio real hoy, aunque ya se haya enviado
 *
 *  Usa correoEnviar_ (CORREO_RESEND.gs) por medio de kevMandar_ y el formato
 *  de KARDEX_EVALUACION.gs (kev*). Todas las funciones de este archivo llevan
 *  el prefijo seg para no chocar con las del resto del proyecto.
 * ========================================================================== */

var SEG = {
  RAIZ        : '1E5cePUnqMOwXXl6varsCL2-XOo9JhGCg',     // carpeta raiz de INGESTA_PRODUCTIVIDAD
  CARPETA     : { cons: '07_CONSOLIDADO', inc: '08_INCUMPLIMIENTOS' },
  GH_OWNER    : 'TorredeControlCSS',
  GH_REPO     : 'seguire',
  GH_BRANCH   : 'main',
  RUTA        : { cons: 'data/consolidado.json', inc: 'data/cumplimiento_entregas.json' },
  NOMBRE      : { cons: 'Consolidado de Suministros de Planificación', inc: 'Libro de Incumplimientos de Seguimiento' },
  CONFIG_SS   : '17yYlcBSWxv68Q5UCLJwcw7Zaif5HBnTBvVMsH7Dp4cA',   // BACK_END_CALCULADORA_UE
  CONFIG_SH   : 'CONFIG_ALERTAS',
  PANEL_INC   : 'https://torrecontrolcss.org/seguire/cumplimiento.html',
  PANEL_CONS  : 'https://torrecontrolcss.org/seguire/',
  LOGO        : 'https://raw.githubusercontent.com/TorredeControlCSS/SIGUELO/main/icons/icon-192.png',
  TZ          : 'America/Panama',
  REMITENTE   : 'Torre de Control - CSS',
  PROP_PEND   : 'SEG_PENDIENTES',
  PROP_EJEC   : 'SEG_EJECUCION',
  PROP_PREVIO : 'SEG_INC_PREVIO',
  POR_VENCER  : 15,      // consolidado: dias para "Por vencer"
  VENTANA_AV  : 15,      // incumplimientos: dias para el aviso preventivo
  SIN_NOT_DIAS: 5,       // vencida hace mas de N dias sin nota a Compras
  TOPE        : 5,       // filas por lista en el cuerpo del correo
  ATRASO_LIBRO: 3,       // dias sin cargar el libro antes de pedirlo en el correo
  PISO        : 0.70     // no se publica si el archivo trae menos del 70 % de filas que lo publicado
};

/* ──────────────────────────────────────────────────────────────────────────
 *  GANCHO DE doGet (Codigo.gs):
 *    if (typeof segRuta_ === 'function') { var _seg = segRuta_(e); if (_seg) return createOutput_(_seg, callback); }
 * ────────────────────────────────────────────────────────────────────────── */
function segRuta_(e) {
  var p = (e && e.parameter) || {};
  var a = String(p.action || '');
  if (a === 'segPublicar') return segProgramar_(p.tablero);
  if (a === 'segEstado')   return segEstadoTxt_();
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  PUBLICACION DIFERIDA
 * ────────────────────────────────────────────────────────────────────────── */
function segProgramar_(tablero) {
  var t = String(tablero || '').toLowerCase();
  if (!SEG.CARPETA[t]) return { ok: false, error: 'Tablero no válido: ' + t };
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    var pend = {};
    try { pend = JSON.parse(props.getProperty(SEG.PROP_PEND) || '{}') || {}; } catch (e0) { pend = {}; }
    pend[t] = segAhora_();
    props.setProperty(SEG.PROP_PEND, JSON.stringify(pend));
    ScriptApp.getProjectTriggers().forEach(function (tr) {
      if (tr.getHandlerFunction() === 'segDisparoUnico') ScriptApp.deleteTrigger(tr);
    });
    ScriptApp.newTrigger('segDisparoUnico').timeBased().after(30 * 1000).create();
    segMarcar_(t, { ok: true, estado: 'corriendo', desde: segAhora_() });
    return { ok: true, estado: 'corriendo', tablero: t,
             mensaje: 'El tablero se actualizará en aproximadamente un minuto.' };
  } catch (e) {
    segMarcar_(t, { ok: false, estado: 'error', error: String(e) });
    return { ok: false, estado: 'error', error: String(e) };
  } finally {
    try { lock.releaseLock(); } catch (e1) {}
  }
}

/* Publica a proposito: un disparador solo puede llamar funciones publicas. */
function segDisparoUnico() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'segDisparoUnico') ScriptApp.deleteTrigger(tr);
  });
  var props = PropertiesService.getScriptProperties();
  var pend = {};
  try { pend = JSON.parse(props.getProperty(SEG.PROP_PEND) || '{}') || {}; } catch (e0) { pend = {}; }
  props.deleteProperty(SEG.PROP_PEND);
  ['inc', 'cons'].forEach(function (t) {
    if (!pend[t]) return;
    var r = segPublicar_(t, false);
    segMarcar_(t, r.ok ? { ok: true, estado: 'listo', fin: segAhora_(), filas: r.filas, corte: r.corte }
                      : { ok: false, estado: r.abortado ? 'abortado' : 'error', fin: segAhora_(), error: r.error });
    Logger.log('SEG ' + t + ' -> ' + JSON.stringify(r));
  });
}

function segPublicarAhoraConsolidado()     { Logger.log(JSON.stringify(segPublicar_('cons', true))); }
function segPublicarAhoraIncumplimientos() { Logger.log(JSON.stringify(segPublicar_('inc', true))); }

function segMarcar_(t, obj) {
  var props = PropertiesService.getScriptProperties();
  var all = {};
  try { all = JSON.parse(props.getProperty(SEG.PROP_EJEC) || '{}') || {}; } catch (e) { all = {}; }
  all[t] = obj;
  props.setProperty(SEG.PROP_EJEC, JSON.stringify(all));
}
function segEstadoTxt_() {
  var all = {};
  try { all = JSON.parse(PropertiesService.getScriptProperties().getProperty(SEG.PROP_EJEC) || '{}') || {}; } catch (e) {}
  return { ok: true, estado: all };
}

function segPublicar_(t, forzar) {
  var t0 = Date.now();
  try {
    var arch = segArchivoVigente_(t);
    if (!arch) return { ok: false, error: 'No hay ningún .xlsx en la carpeta ' + SEG.CARPETA[t] + ' de la Ventanilla Única.' };
    var libro = segXlsxAbrir_(arch.file.getBlob());
    var obj = (t === 'cons') ? segConstruirConsolidado_(libro, arch.fecha)
                             : segConstruirCumplimiento_(libro, arch.fecha);
    obj._meta.fuente = arch.file.getName();
    obj._meta.archivoModificado = Utilities.formatDate(arch.file.getLastUpdated(), SEG.TZ, 'yyyy-MM-dd HH:mm:ss');
    obj._meta.segundos = Math.round((Date.now() - t0) / 1000);
    var r = segGitPublicar_(SEG.RUTA[t], obj, forzar);
    if (!r.ok) return r;
    return { ok: true, filas: obj.rows.length, corte: obj.corte, generado: obj._meta.generado,
             kb: r.kb, segundos: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  ARCHIVO VIGENTE EN DRIVE
 * ────────────────────────────────────────────────────────────────────────── */
function segArchivoVigente_(t) {
  var raiz;
  try { raiz = DriveApp.getFolderById(SEG.RAIZ); }
  catch (e) { throw new Error('No se pudo abrir la carpeta raíz de la Ventanilla Única (' + SEG.RAIZ + '). Compártala con la cuenta que ejecuta SÍGUELO.'); }
  var it = raiz.getFoldersByName(SEG.CARPETA[t]);
  if (!it.hasNext()) return null;
  var mejor = null;
  var re = /_(\d{4}-\d{2}-\d{2})(?:_v(\d+))?\.xlsx$/i;
  var recorrer = function (f, prof) {
    var fs = f.getFiles();
    while (fs.hasNext()) {
      var x = fs.next(), m = re.exec(x.getName());
      if (!m) continue;
      var c = { file: x, fecha: m[1], v: m[2] ? +m[2] : 1, creado: x.getDateCreated().getTime() };
      if (!mejor || c.fecha > mejor.fecha || (c.fecha === mejor.fecha && (c.v > mejor.v || (c.v === mejor.v && c.creado > mejor.creado)))) mejor = c;
    }
    if (prof < 2) { var ds = f.getFolders(); while (ds.hasNext()) recorrer(ds.next(), prof + 1); }
  };
  while (it.hasNext()) recorrer(it.next(), 0);
  return mejor;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  LECTOR DE XLSX (valores en cache, sin convertir)
 *  segXlsxAbrir_(blob) -> libro; segXlsxHoja_(libro, nombre, desde, hastaCol)
 *  devuelve filas (indice 0 = fila "desde") de valores: numero, texto,
 *  booleano, Date (UTC) si la celda tiene formato de fecha, o null.
 * ────────────────────────────────────────────────────────────────────────── */
function segXlsxAbrir_(blob) {
  var b2 = blob.getContentType() === 'application/zip' ? blob : blob.copyBlob().setContentType('application/zip');
  var partes = Utilities.unzip(b2), mapa = {};
  partes.forEach(function (p) { mapa[p.getName()] = p; });
  var txt = function (n) { var p = mapa[n]; return p ? p.getDataAsString('UTF-8') : ''; };
  return segXlsxLibro_(txt);
}

/* nucleo puro: recibe una funcion que devuelve el texto de cada parte del zip */
function segXlsxLibro_(txt) {
  var wb = txt('xl/workbook.xml'), rels = txt('xl/_rels/workbook.xml.rels');
  var rid = {}, m, re = /<Relationship\b[^>]*>/g;
  while ((m = re.exec(rels))) {
    var id = /\bId="([^"]+)"/.exec(m[0]), tg = /\bTarget="([^"]+)"/.exec(m[0]);
    if (id && tg) { var t = tg[1].replace(/^\//, ''); rid[id[1]] = t.indexOf('xl/') === 0 ? t : 'xl/' + t; }
  }
  var hojas = {};
  re = /<sheet\b[^>]*>/g;
  while ((m = re.exec(wb))) {
    var nm = /\bname="([^"]*)"/.exec(m[0]), r = /\br:id="([^"]+)"/.exec(m[0]);
    if (nm && r) hojas[segXmlDec_(nm[1])] = rid[r[1]];
  }
  var ss = [], sx = txt('xl/sharedStrings.xml');
  re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  while ((m = re.exec(sx))) {
    var cuerpo = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), s = '', tt, rt = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    while ((tt = rt.exec(cuerpo))) s += tt[1] || '';
    ss.push(segXmlDec_(s));
  }
  var st = txt('xl/styles.xml'), fmt = {};
  re = /<numFmt\b[^>]*>/g;
  while ((m = re.exec(st))) {
    var fid = /numFmtId="(\d+)"/.exec(m[0]), fc = /formatCode="([^"]*)"/.exec(m[0]);
    if (fid && fc) fmt[fid[1]] = segXmlDec_(fc[1]);
  }
  var esFecha = [], xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
  if (xfs) {
    re = /<xf\b[^>]*>/g;
    while ((m = re.exec(xfs[1]))) {
      var n = /numFmtId="(\d+)"/.exec(m[0]), idn = n ? +n[1] : 0, f = false;
      if ((idn >= 14 && idn <= 22) || (idn >= 45 && idn <= 47)) f = true;
      else if (fmt[idn] !== undefined) {
        var c = fmt[idn].replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
        f = /[dmyhs]/i.test(c) && !/^general$/i.test(c);
      }
      esFecha.push(f);
    }
  }
  return { txt: txt, hojas: hojas, ss: ss, esFecha: esFecha };
}

function segXlsxHoja_(libro, nombre, desde, hastaCol) {
  var ruta = libro.hojas[nombre];
  if (!ruta) throw new Error('El libro no tiene la hoja «' + nombre + '».');
  var x = libro.txt(ruta), filas = [], m;
  var re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, ult = 0;
  while ((m = re.exec(x))) {
    var at = m[1], ref = /\br="([A-Z]+)(\d+)"/.exec(at);
    if (!ref) continue;
    var fila = +ref[2];
    if (fila < desde) continue;
    var col = 0, L = ref[1];
    for (var i = 0; i < L.length; i++) col = col * 26 + (L.charCodeAt(i) - 64);
    col -= 1;
    if (col > hastaCol) continue;
    var cuerpo = m[2] || '', tp = /\bt="([^"]+)"/.exec(at), t = tp ? tp[1] : 'n';
    var sv = /\bs="(\d+)"/.exec(at), sIdx = sv ? +sv[1] : 0;
    var v = null, vv = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cuerpo);
    if (t === 's') { if (vv) v = libro.ss[+vv[1]]; }
    else if (t === 'inlineStr') { var it = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cuerpo); v = it ? segXmlDec_(it[1]) : ''; }
    else if (t === 'str' || t === 'e') { if (vv) v = segXmlDec_(vv[1]); }
    else if (t === 'b') { if (vv) v = vv[1] === '1'; }
    else if (vv) {
      var num = Number(vv[1]);
      if (libro.esFecha[sIdx] && isFinite(num) && num >= 0 && num < 2958466) v = segSerialFecha_(num);
      else v = num;
    }
    if (v === null || v === '') { if (t !== 'inlineStr' && t !== 's' && t !== 'str') continue; }
    var k = fila - desde;
    while (filas.length <= k) filas.push([]);
    filas[k][col] = v;
    if (k > ult) ult = k;
  }
  for (var j = 0; j < filas.length; j++) {
    var f = filas[j] || [];
    for (var c = 0; c <= hastaCol; c++) if (f[c] === undefined) f[c] = null;
    filas[j] = f;
  }
  return filas;
}

function segSerialFecha_(n) {
  var ms = Math.round((n - 25569) * 86400000);   // 25569 = 1970-01-01 en serie de Excel
  if (n < 60) ms += 86400000;                     // Excel cuenta el 29-feb-1900 inexistente
  return new Date(ms);
}
function segXmlDec_(s) {
  return String(s).replace(/_x000D_|\r/g, '').replace(/_x([0-9A-Fa-f]{4})_/g, function (a, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, function (a, e) {
      if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&';
      if (e === 'quot') return '"'; if (e === 'apos') return "'";
      return String.fromCharCode(e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
}
function segEsFecha_(v) { return v instanceof Date && !isNaN(v.getTime()); }
function segIso_(v) {
  if (!segEsFecha_(v)) return null;
  return v.getUTCFullYear() + '-' + ('0' + (v.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + v.getUTCDate()).slice(-2);
}
function segNum_(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
/* str() de Python, para las llaves que el libro arma concatenando columnas */
function segPy_(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True'; if (v === false) return 'False';
  return String(v);
}
function segAhora_() { return Utilities.formatDate(new Date(), SEG.TZ, 'yyyy-MM-dd HH:mm:ss'); }

/* ──────────────────────────────────────────────────────────────────────────
 *  1 · CONSOLIDADO DE SUMINISTROS DE PLANIFICACION  (hoja DATA)
 *  Mismas columnas y reglas del JSON que ya lee SEGUIRE.
 * ────────────────────────────────────────────────────────────────────────── */
var SEG_CONS_COLS = ['cod', 'sap', 'desc', 'tipo', 'ven', 'analista', 'compra', 'acto', 'prov', 'precio', 'consDensyps',
  'consActo', 'despacho', 'inv', 'cob', 'cond', 'estatus', 'saldo', 'saldoB', 'ejec', 'doc', 'fTermino', 'aRecibir',
  'obs', 'motivo', 'seg', 'ent', 'dias'];

function segConstruirConsolidado_(libro, corte) {
  var X = segXlsxHoja_(libro, 'DATA', 5, 92);
  var anioMin = +corte.slice(0, 4) - 1;
  var cor = Date.UTC(+corte.slice(0, 4), +corte.slice(5, 7) - 1, +corte.slice(8, 10));
  var tx = function (v) {
    if (v === null || v === undefined || v === 0) return '';
    if (segEsFecha_(v)) return segIso_(v);
    var s = String(v).replace(/\s+/g, ' ').trim();
    return s === '-' ? '' : s;
  };
  var tit = function (v) { return tx(v).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, function (a, p, l) { return p + l.toUpperCase(); }); };
  var nu = function (v) { return Math.round(segNum_(v) * 10000) / 10000; };
  var rows = [], conDoc = 0;
  X.forEach(function (x) {
    if (x[1] === null || x[1] === undefined || x[1] === '') return;
    var f = x[57], fT = (segEsFecha_(f) && f.getUTCFullYear() >= anioMin) ? segIso_(f) : '';
    var o = {
      cod: tx(x[1]), sap: tx(x[2]), desc: tx(x[3]), tipo: tit(x[10]), ven: tx(x[5]), analista: tx(x[7]),
      compra: tit(x[12]), acto: tx(x[13]), prov: tx(x[21]), precio: nu(x[18]), consDensyps: nu(x[33]),
      consActo: nu(x[23]), despacho: nu(x[38]), inv: nu(x[44]), cob: nu(x[48]), cond: tit(x[50]),
      estatus: tit(x[66]), saldo: nu(x[68]), saldoB: nu(x[71]), ejec: nu(x[70]), doc: tx(x[54]),
      fTermino: fT, aRecibir: nu(x[58]), obs: tx(x[74]), motivo: tx(x[92])
    };
    var e = o.estatus.toUpperCase().replace(/[ÁÀ]/g, 'A').replace(/[ÉÈ]/g, 'E').replace(/[ÍÌ]/g, 'I').replace(/[ÓÒ]/g, 'O').replace(/[ÚÙÜ]/g, 'U');
    if (e === 'SIN TRAMITE') o.estatus = 'Sin Tramite';     // el libro escribe SIN TRAMITE y SIN TRÁMITE
    o.seg = (o.cond !== 'Agotado' && o.cond !== 'Critico') ? '' :
            (e.indexOf('REFREND') >= 0 && e.indexOf('NO REFREND') < 0 && o.saldo > 0) ? 'Ejecución' :
            (e.indexOf('SIN TRAMIT') >= 0) ? 'Compra' : 'Otros';
    if (!o.fTermino) { o.ent = 'Sin solicitud'; o.dias = null; }
    else {
      var dd = Math.round((Date.UTC(+fT.slice(0, 4), +fT.slice(5, 7) - 1, +fT.slice(8, 10)) - cor) / 86400000);
      o.dias = dd;
      o.ent = o.aRecibir <= 0 ? 'Recibida' : dd < 0 ? 'Vencida' : dd <= SEG.POR_VENCER ? 'Por vencer' : 'En plazo';
    }
    if (o.doc) conDoc++;
    rows.push(SEG_CONS_COLS.map(function (k) { return o[k]; }));
  });
  if (rows.length < 100) throw new Error('La hoja DATA trae solo ' + rows.length + ' renglones con código. ¿Es el consolidado correcto?');
  return { corte: corte, cols: SEG_CONS_COLS, rows: rows,
           _meta: { generado: segAhora_(), tablero: 'consolidado', filas: rows.length, conDocumento: conDoc } };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  2 · LIBRO DE INCUMPLIMIENTOS DE SEGUIMIENTO
 *  Hojas «Base de Datos» (una fila por nota de solicitud de entrega, desde la
 *  fila 4), «Entradas» (cada entrada al CEDIS) y «CATALOGO». El JSON lleva los
 *  hechos de cada nota; el resultado (cumplida, en plazo, vencida) y los dias
 *  de atraso se calculan contra la fecha de HOY en el tablero y en el correo
 *  (segIncEstado_), asi el tablero no envejece entre una carga y la otra.
 * ────────────────────────────────────────────────────────────────────────── */
var SEG_INC_COLS = ['req', 'nota', 'cedis', 'inv', 'cod', 'desc', 'plan', 'prov', 'qty', 'recib', 'saldo', 'venc', 'pri',
  'ult', 'estHoja', 'precio', 'et', 'notC', 'fAviso', 'notP', 'fNotP'];

function segConstruirCumplimiento_(libro, corte) {
  var ser = function (v) { return segEsFecha_(v) ? segIso_(v) : (v === undefined ? null : v); };
  var E = {}, ultEntrada = '';
  segXlsxHoja_(libro, 'Entradas', 2, 4).forEach(function (x) {
    if (!x[0] || !x[2]) return;
    var k = segPy_(x[2]) + segPy_(x[3]);
    (E[k] = E[k] || []).push([x[0], segNum_(x[4])]);
    if (segEsFecha_(x[0]) && x[0].getUTCFullYear() < 2030) { var i = segIso_(x[0]); if (i > ultEntrada && i <= corte) ultEntrada = i; }
  });
  var cat = {};
  segXlsxHoja_(libro, 'CATALOGO', 2, 20).forEach(function (x) { if (x[14]) cat[segPy_(x[14])] = [x[17], x[19], x[20]]; });
  var rows = [];
  segXlsxHoja_(libro, 'Base de Datos', 4, 29).forEach(function (r) {
    if (!r[0] || !r[7]) return;
    var req = r[0], nota = r[4], cod = segPy_(r[7]).split('.')[0], qty = segNum_(r[9]);
    var ent = E[segPy_(req) + segPy_(nota)] || [], recib = 0, fechas = [];
    ent.forEach(function (z) { recib += z[1]; if (segEsFecha_(z[0]) && z[0].getUTCFullYear() < 2030) fechas.push(segIso_(z[0])); });
    fechas.sort();
    var d = cat[cod] || [null, null, null], notc = r[16];
    var sinnot = (typeof notc === 'string') && notc.toUpperCase().indexOf('SIN') >= 0;
    var et = 0;
    if (notc && !sinnot) et = 1;
    if (r[18]) et = 2; if (r[20]) et = 3; if (r[21]) et = 4; if (r[22]) et = 5;
    var o = {
      req: req, nota: segPy_(nota), cedis: (r[5] === null || r[5] === '' || r[5] === 0) ? '' : segPy_(r[5]), inv: ser(r[6]), cod: cod,
      desc: ser(d[0]), plan: ser(r[25]), prov: (r[13] ? segPy_(r[13]) : '').trim(), qty: qty, recib: recib,
      saldo: Math.max(0, qty - recib), venc: segEsFecha_(r[1]) ? segIso_(r[1]) : null,
      pri: fechas.length ? fechas[0] : null, ult: fechas.length ? fechas[fechas.length - 1] : null,
      estHoja: ser(r[15]), precio: segNum_(r[29]) || (d[2] ? segNum_(d[2]) : 0), et: et,
      notC: sinnot ? null : ser(notc), fAviso: segEsFecha_(r[17]) ? segIso_(r[17]) : null, notP: ser(r[18]),
      fNotP: segEsFecha_(r[19]) ? segIso_(r[19]) : null
    };
    rows.push(SEG_INC_COLS.map(function (k) { return o[k]; }));
  });
  if (rows.length < 100) throw new Error('La hoja «Base de Datos» trae solo ' + rows.length + ' notas. ¿Es el libro correcto?');
  return { corte: corte, cols: SEG_INC_COLS, rows: rows,
           _meta: { generado: segAhora_(), tablero: 'cumplimiento', filas: rows.length, ultimaEntrada: ultEntrada || null,
                    entradas: Object.keys(E).length } };
}

/* Resultado de una nota contra la fecha "hoy" (AAAA-MM-DD). Igual en cumplimiento.html. */
function segIncEstado_(r, hoy) {
  var dias = function (a, b) { return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000); };
  var est;
  if (!r.venc) est = 'Sin fecha';
  else if (r.saldo <= 0) est = (r.ult && r.ult <= r.venc) ? 'Cumplida a tiempo' : 'Cumplida con atraso';
  else if (r.venc >= hoy) est = 'En plazo';
  else if (r.recib > 0) est = 'Vencida con entrega parcial';
  else est = 'Vencida sin entrega';
  var ref = r.saldo <= 0 ? r.ult : hoy;
  return { est: est, atraso: (r.venc && ref && ref > r.venc) ? dias(ref, r.venc) : 0 };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  GITHUB
 * ────────────────────────────────────────────────────────────────────────── */
function segGitHd_() {
  var token = PropertiesService.getScriptProperties().getProperty('GH_TOKEN');
  if (!token) throw new Error('Falta GH_TOKEN en las propiedades del script de SÍGUELO.');
  return { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
}
function segGitApi_(ruta) { return 'https://api.github.com/repos/' + SEG.GH_OWNER + '/' + SEG.GH_REPO + '/contents/' + ruta; }

function segGitLeer_(ruta) {
  var hd = segGitHd_();
  var r = UrlFetchApp.fetch(segGitApi_(ruta) + '?ref=' + SEG.GH_BRANCH, { method: 'get', headers: hd, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  var meta = JSON.parse(r.getContentText()), b64 = meta.content;
  if (!b64 && meta.sha) {
    var bl = UrlFetchApp.fetch('https://api.github.com/repos/' + SEG.GH_OWNER + '/' + SEG.GH_REPO + '/git/blobs/' + meta.sha,
      { method: 'get', headers: hd, muteHttpExceptions: true });
    if (bl.getResponseCode() !== 200) return null;
    b64 = JSON.parse(bl.getContentText()).content;
  }
  if (!b64) return { sha: meta.sha, obj: null };
  var obj = null;
  try { obj = JSON.parse(Utilities.newBlob(Utilities.base64Decode(String(b64).replace(/\s/g, ''))).getDataAsString('UTF-8')); } catch (e) {}
  return { sha: meta.sha, obj: obj };
}

function segGitPublicar_(ruta, obj, forzar) {
  var hd = segGitHd_(), previo = null;
  try { previo = segGitLeer_(ruta); } catch (e0) { previo = null; }
  if (previo && previo.obj && previo.obj.rows && !forzar) {
    var n0 = previo.obj.rows.length, n1 = obj.rows.length;
    if (n1 < n0 * SEG.PISO)
      return { ok: false, abortado: true, error: 'El archivo nuevo trae ' + n1 + ' filas y lo publicado tiene ' + n0 +
               '. Parece incompleto: no se publica. Si es correcto, publique desde el editor con segPublicarAhora….' };
    if (previo.obj.corte && obj.corte < previo.obj.corte)
      return { ok: false, abortado: true, error: 'El archivo nuevo es del ' + obj.corte + ' y lo publicado es del ' +
               previo.obj.corte + '. No se publica un corte anterior.' };
  }
  var contenido = JSON.stringify(obj);
  var payload = { message: 'Actualizar ' + ruta + ' (corte ' + obj.corte + ', ' + obj._meta.generado + ')',
                  content: Utilities.base64Encode(Utilities.newBlob(contenido, 'application/json').getBytes()), branch: SEG.GH_BRANCH };
  if (previo && previo.sha) payload.sha = previo.sha;
  var pr = UrlFetchApp.fetch(segGitApi_(ruta), { method: 'put', headers: hd, contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = pr.getResponseCode();
  if (code === 200 || code === 201) return { ok: true, kb: Math.round(contenido.length / 1024) };
  return { ok: false, error: 'GitHub respondió ' + code + ': ' + pr.getContentText().slice(0, 300) };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  CONFIG_ALERTAS (BACK_END_CALCULADORA_UE)
 * ────────────────────────────────────────────────────────────────────────── */
var SEG_CFG_FILAS = [
  ['INCUMP_ACTIVO', 'NO', 'SI/NO · correo diario de Cumplimiento de Entregas (libro de Incumplimientos de Seguimiento). En NO no se envía.'],
  ['INCUMP_TO', 'yassjimenez@css.gob.pa, marlperalta@css.gob.pa, ygarcia@css.gob.pa, hherrera@css.gob.pa, mcernichiaro@css.gob.pa, vdeleon@css.gob.pa, sisotillo@css.gob.pa, almaitin@css.gob.pa, edilbatista@css.gob.pa, argelismoreno@css.gob.pa',
    'Jefaturas que reciben el correo diario de Cumplimiento de Entregas · PARA (separados por coma)'],
  ['INCUMP_CC', '', 'Cumplimiento de Entregas · copia (CC), separados por coma'],
  ['INCUMP_PRUEBA_A', '', 'Correo de prueba: si tiene valor, el correo de Cumplimiento de Entregas va SOLO a este correo'],
  ['INCUMP_DIAS', 'L-V', 'Días de envío de Cumplimiento de Entregas: L-V, L-S, DIARIO o L,M,X,J,V,S,D']
];

function segCfgLeer_() {
  var sh = SpreadsheetApp.openById(SEG.CONFIG_SS).getSheetByName(SEG.CONFIG_SH);
  if (!sh) throw new Error('BACK_END_CALCULADORA_UE no tiene la hoja ' + SEG.CONFIG_SH + '.');
  var v = sh.getDataRange().getValues(), m = {};
  for (var i = 1; i < v.length; i++) { var k = String(v[i][0] || '').trim().toUpperCase(); if (k) m[k] = String(v[i][1] === null ? '' : v[i][1]).trim(); }
  var lista = function (s) { return String(s || '').split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); }); };
  return { activo: String(m.INCUMP_ACTIVO || 'NO').toUpperCase() === 'SI', to: lista(m.INCUMP_TO), cc: lista(m.INCUMP_CC),
           prueba: lista(m.INCUMP_PRUEBA_A), dias: String(m.INCUMP_DIAS || 'L-V').toUpperCase(), existe: m.INCUMP_TO !== undefined };
}

/* Agrega al final de CONFIG_ALERTAS las filas INCUMP_* que falten. No modifica ni mueve ninguna otra fila. */
function segCrearConfigAlertas() {
  var sh = SpreadsheetApp.openById(SEG.CONFIG_SS).getSheetByName(SEG.CONFIG_SH);
  if (!sh) { Logger.log('SEG no existe la hoja ' + SEG.CONFIG_SH); return; }
  var v = sh.getDataRange().getValues(), hay = {};
  v.forEach(function (r) { hay[String(r[0] || '').trim().toUpperCase()] = true; });
  var nuevas = SEG_CFG_FILAS.filter(function (r) { return !hay[r[0]]; });
  if (!nuevas.length) { Logger.log('SEG CONFIG_ALERTAS ya tiene las filas INCUMP_*: no se tocó nada.'); return; }
  sh.getRange(sh.getLastRow() + 1, 1, nuevas.length, 3).setValues(nuevas);
  Logger.log('SEG agregadas a CONFIG_ALERTAS: ' + nuevas.map(function (r) { return r[0]; }).join(', '));
}

function segToca_(dias, fecha) {
  var d = fecha.getDay();               // 0 domingo
  var L = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][d];
  if (dias === 'DIARIO') return true;
  if (dias === 'L-V') return d >= 1 && d <= 5;
  if (dias === 'L-S') return d >= 1;
  return dias.split(/[,\s]+/).indexOf(L) >= 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  CORREO DIARIO · CUMPLIMIENTO DE ENTREGAS
 * ────────────────────────────────────────────────────────────────────────── */
function segInstalarCorreoDiario() {
  var ya = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'segIncCorreoDiario'; });
  if (ya) { Logger.log('SEG el activador diario ya existe: no se creó otro.'); return; }
  ScriptApp.newTrigger('segIncCorreoDiario').timeBased().everyDays(1).atHour(6).nearMinute(40).inTimezone(SEG.TZ).create();
  Logger.log('SEG activador diario creado (6:40 a. m., hora de Panamá).');
}

function segIncCorreoDiario() { segIncEnviar_(false); }
function segIncEnviarAhora()  { segIncEnviar_(true); }

function segIncEnviarmePrueba() {
  var cfg = segCfgLeer_();
  var yo = cfg.prueba.length ? cfg.prueba : [Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail()];
  var R = segIncConstruir_();
  segIncMandar_(yo, [], segIncArmar_(R, true, cfg));
  Logger.log('SEG prueba enviada a ' + yo.join(', ') + ' · lista real: ' + cfg.to.join(', ') + (cfg.cc.length ? ' · CC ' + cfg.cc.join(', ') : ''));
}

function segIncEnviar_(forzar) {
  var cfg = segCfgLeer_();
  if (!forzar && !cfg.activo) { Logger.log('SEG INCUMP_ACTIVO = NO: no se envía.'); return; }
  if (!forzar && !segToca_(cfg.dias, new Date())) { Logger.log('SEG hoy no es día de envío (' + cfg.dias + ').'); return; }
  var hoy = Utilities.formatDate(new Date(), SEG.TZ, 'yyyy-MM-dd');
  var pr = PropertiesService.getScriptProperties(), prev = null;
  try { prev = JSON.parse(pr.getProperty(SEG.PROP_PREVIO) || 'null'); } catch (e) {}
  if (!forzar && prev && prev.hoy === hoy) { Logger.log('SEG ya se envió hoy.'); return; }
  var para = cfg.prueba.length ? cfg.prueba : cfg.to, cc = cfg.prueba.length ? [] : cfg.cc;
  if (!para.length) { Logger.log('SEG INCUMP_TO no tiene ningún correo válido.'); return; }
  var R = segIncConstruir_();
  segIncMandar_(para, cc, segIncArmar_(R, !!cfg.prueba.length, cfg));
  pr.setProperty(SEG.PROP_PREVIO, JSON.stringify({ hoy: hoy, corte: R.corte, k: R.k }));
  Logger.log('SEG enviado a ' + para.join(', ') + (cc.length ? ' · CC ' + cc.join(', ') : '') + ' · libro al ' + R.corte);
}

function segIncMandar_(para, cc, m) {
  if (typeof kevMandar_ === 'function') { kevMandar_(para, cc, m); return; }
  var op = { to: para.join(','), subject: m.asunto, htmlBody: m.html, body: 'Este correo requiere un cliente con HTML.', name: SEG.REMITENTE };
  if (cc.length) op.cc = cc.join(',');
  if (m.excel) op.attachments = [m.excel];
  if (typeof correoEnviar_ === 'function') correoEnviar_(op); else MailApp.sendEmail(op.to, op.subject, op.body, op);
}

function segIncConstruir_() {
  var g = segGitLeer_(SEG.RUTA.inc);
  if (!g || !g.obj || !g.obj.rows) throw new Error('No se pudo leer ' + SEG.RUTA.inc + ' del repositorio ' + SEG.GH_REPO + '.');
  var D = g.obj, C = D.cols, hoy = Utilities.formatDate(new Date(), SEG.TZ, 'yyyy-MM-dd');
  var dias = function (a, b) { return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000); };
  var R = D.rows.map(function (a) { var o = {}; C.forEach(function (c, i) { o[c] = a[i]; }); var e = segIncEstado_(o, hoy); o.est = e.est; o.atraso = e.atraso; o.valor = (o.saldo || 0) * (o.precio || 0); return o; });
  var venc = R.filter(function (r) { return r.est.indexOf('Vencida') === 0; });
  var sinN = venc.filter(function (r) { return r.et === 0 && r.atraso > SEG.SIN_NOT_DIAS; }).sort(function (a, b) { return b.valor - a.valor; });
  var sinP = venc.filter(function (r) { return r.et === 1; }).sort(function (a, b) { return b.valor - a.valor; });
  var nuevas = venc.filter(function (r) { return r.atraso >= 1 && r.atraso <= 7; }).sort(function (a, b) { return a.atraso - b.atraso || b.valor - a.valor; });
  var prox = R.filter(function (r) { return r.est === 'En plazo' && r.venc && dias(r.venc, hoy) <= SEG.VENTANA_AV; })
              .map(function (r) { r.faltan = dias(r.venc, hoy); return r; }).sort(function (a, b) { return a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : b.valor - a.valor; });
  var prov = {};
  R.forEach(function (r) {
    var k = r.prov || '—', o = prov[k] = prov[k] || { prov: k, n: 0, at: 0, ct: 0, v: 0, sv: 0 };
    o.n++; if (r.est === 'Cumplida a tiempo') o.at++; if (r.est === 'Cumplida con atraso') o.ct++;
    if (r.est.indexOf('Vencida') === 0) { o.v++; o.sv += r.valor; }
  });
  var provs = Object.keys(prov).map(function (k) { var o = prov[k]; o.pt = (o.at + o.ct) ? o.at / (o.at + o.ct) : null; return o; })
                .filter(function (o) { return o.v > 0; }).sort(function (a, b) { return b.sv - a.sv; });
  var cad = [0, 1, 2, 3, 4, 5].map(function (k) { return venc.filter(function (r) { return r.et >= k; }).length; });
  var cerr = R.filter(function (r) { return r.est.indexOf('Cumplida') === 0; }), aTiempo = cerr.filter(function (r) { return r.est === 'Cumplida a tiempo'; }).length;
  var suma = function (a) { return a.reduce(function (s, r) { return s + r.valor; }, 0); };
  var diasLibro = dias(hoy, D.corte);
  return { corte: D.corte, generado: D._meta && D._meta.generado, ultEntrada: D._meta && D._meta.ultimaEntrada, hoy: hoy, diasLibro: diasLibro,
           R: R, venc: venc, sinN: sinN, sinP: sinP, nuevas: nuevas, prox: prox, prox3: prox.filter(function (r) { return r.faltan <= 3; }),
           provs: provs, cad: cad, vencValor: suma(venc), pctTiempo: cerr.length ? aTiempo / cerr.length : null, cerradas: cerr.length,
           k: { venc: venc.length, valor: Math.round(suma(venc)), sinN: sinN.length, prox: prox.length } };
}

function segIncAcciones_(R) {
  var nf = segNf_, A = [];
  if (R.diasLibro > SEG.ATRASO_LIBRO) A.push({ resp: 'Seguimiento', tono: 'r', n: R.diasLibro + ' d', corto: 'el libro de Incumplimientos no se ha cargado: subirlo en la Ventanilla Única',
    txt: 'Cargar el libro de Incumplimientos en la Ventanilla Única: el último es del ' + segFechaTxt_(R.corte) + ', hace ' + R.diasLibro + ' días. Mientras no se cargue, este correo repite las mismas notas.' });
  if (R.sinN.length) A.push({ resp: 'Seguimiento', tono: 'r', n: nf(R.sinN.length), corto: 'notas vencidas hace más de ' + SEG.SIN_NOT_DIAS + ' días sin nota de incumplimiento a Compras: notificarlas', valor: segSuma_(R.sinN),
    txt: 'Notificar a Compras ' + nf(R.sinN.length) + ' notas vencidas hace más de ' + SEG.SIN_NOT_DIAS + ' días que no tienen nota de incumplimiento (B/. ' + nf(segSuma_(R.sinN)) + ' de saldo).' });
  if (R.sinP.length) A.push({ resp: 'Compras', tono: 'a', n: nf(R.sinP.length), corto: 'notas ya notificadas a Compras que no se han notificado al proveedor', valor: segSuma_(R.sinP),
    txt: 'Notificar al proveedor ' + nf(R.sinP.length) + ' notas que Seguimiento ya informó a Compras (B/. ' + nf(segSuma_(R.sinP)) + ' de saldo).' });
  if (R.prox3.length) A.push({ resp: 'Seguimiento y Planificación', tono: 'a', n: nf(R.prox3.length), corto: 'notas con saldo que vencen en 3 días o menos: aviso preventivo al proveedor',
    txt: 'Enviar aviso preventivo al proveedor de ' + nf(R.prox3.length) + ' notas con saldo que vencen en 3 días o menos.' });
  if (R.nuevas.length) A.push({ resp: 'Seguimiento', tono: 'n', n: nf(R.nuevas.length), corto: 'notas que vencieron en los últimos 7 días: abrir su seguimiento',
    txt: 'Abrir el seguimiento de ' + nf(R.nuevas.length) + ' notas que vencieron en los últimos 7 días con saldo pendiente.' });
  return A;
}

function segIncArmar_(R, prueba, cfg) {
  var prev = null;
  try { prev = JSON.parse(PropertiesService.getScriptProperties().getProperty(SEG.PROP_PREVIO) || 'null'); } catch (e) {}
  if (prev && prev.hoy === R.hoy && !prueba) prev = null;
  var excel = null;
  try { excel = segIncExcel_(R); } catch (e) { Logger.log('SEG el Excel falló: ' + (e && e.stack ? e.stack : e)); }
  var n = segIncAcciones_(R).length;
  return { asunto: (prueba ? '[PRUEBA ' + Utilities.formatDate(new Date(), SEG.TZ, 'HH:mm') + '] ' : '') +
             'Cumplimiento de entregas · ' + segNf_(R.venc.length) + ' notas vencidas · ' + n + ' acciones del día',
           html: segIncHtml_(R, prev, prueba, cfg), excel: excel };
}

function segNf_(n, dec) {
  if (typeof kevNf_ === 'function') return kevNf_(n, dec);
  var x = Number(n) || 0, d = dec || 0;
  return x.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function segEsc_(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function segFechaTxt_(iso) { if (!iso) return '—'; var p = String(iso).slice(0, 10).split('-'); return p[2] + '-' + p[1] + '-' + p[0]; }
function segSuma_(a) { return a.reduce(function (s, r) { return s + (r.valor || 0); }, 0); }
function segMillones_(v) { return v >= 1e6 ? 'B/. ' + (v / 1e6).toFixed(2) + ' M' : 'B/. ' + segNf_(v); }

function segIncHtml_(R, prev, prueba, cfg) {
  var e = segEsc_, nf = segNf_, TOP = SEG.TOPE;
  var S = { v: ['#E1F5EE', '#0F6E56'], a: ['#FAEEDA', '#854F0B'], r: ['#FCEBEB', '#791F1F'], n: ['#E6F1FB', '#185FA5'], g: ['#F1EFE8', '#5F5E5A'] };
  var th = function (x, al) { return '<th style="background:#1E5A9E;color:#fff;font-size:10.5px;padding:6px 7px;text-align:' + (al || 'center') + ';font-weight:bold">' + x + '</th>'; };
  var td = function (x, al) { return '<td style="padding:5px 7px;border-bottom:1px solid #E5EAF0;font-size:12px;text-align:' + (al || 'center') + '">' + x + '</td>'; };
  var tabla = function (cab, filas) { return '<table style="border-collapse:collapse;width:100%"><tr>' + cab.join('') + '</tr>' + filas.join('') + '</table>'; };
  var zebra = function (i) { return '<tr style="background:' + (i % 2 ? '#F8FAFC' : '#fff') + '">'; };
  var chip = function (t, tono) { var c = S[tono] || S.g; return '<span style="background:' + c[0] + ';color:' + c[1] + ';font-weight:bold;border-radius:4px;padding:2px 7px;display:inline-block">' + t + '</span>'; };
  var h2 = function (t, s) { return '<div style="font-size:14px;font-weight:bold;color:#0C447C;margin:20px 0 6px;border-bottom:1px solid #C9D6E6;padding-bottom:3px">' + t + (s ? ' <span style="font-weight:normal;color:#666;font-size:11.5px">' + s + '</span>' : '') + '</div>'; };
  var cinta = function (t) { return '<div style="background:#FFE9A8;color:#5C4400;border-radius:6px;padding:8px 11px;margin-top:6px;font-size:12.5px;font-weight:bold">' + t + '</div>'; };
  var mas = function (n, hoja) { return n > TOP ? cinta('Aquí se muestran ' + TOP + ' de ' + nf(n) + '. Abra el Excel adjunto, hoja «' + hoja + '», para la lista completa.') : ''; };
  var dl = function (k) {
    if (!prev || !prev.k || prev.k[k] === undefined) return '';
    var d = R.k[k] - prev.k[k];
    return '<div style="font-size:10.5px;font-weight:normal;margin-top:2px">' + (Math.abs(d) < 1 ? '= igual que ayer' : (d > 0 ? '▲ ' : '▼ ') + nf(Math.abs(d)) + ' vs. ' + e(segFechaTxt_(prev.hoy).slice(0, 5))) + '</div>';
  };
  var tile = function (tit, num, sub, tono, k) {
    var c = S[tono] || S.n;
    return '<td style="vertical-align:top;width:25%;padding:0 4px"><div style="background:' + c[0] + ';border-radius:8px;padding:9px 10px;color:' + c[1] + '">' +
      '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:bold">' + tit + '</div>' +
      '<div style="font-size:22px;font-weight:bold;font-family:Consolas,monospace;margin:2px 0">' + num + '</div>' +
      '<div style="font-size:11px;line-height:1.3">' + sub + '</div>' + (k ? dl(k) : '') + '</div></td>';
  };
  var nodo = function (tit, num, sub, tono) {
    var c = S[tono] || S.n;
    return '<td style="vertical-align:top;width:15%"><div style="background:' + c[0] + ';border-radius:8px;padding:8px 6px;text-align:center;color:' + c[1] + '">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.03em;font-weight:bold;min-height:26px">' + tit + '</div>' +
      '<div style="font-size:20px;font-weight:bold;font-family:Consolas,monospace;margin:2px 0">' + num + '</div>' +
      '<div style="font-size:10.5px">' + sub + '</div></div></td>';
  };
  var flecha = '<td style="width:2%;text-align:center;vertical-align:middle;font-size:16px;color:#1E5A9E;font-weight:bold">&#10132;</td>';
  var barras = function (items, max) {
    max = Math.max(max || 0, 1);
    return '<table role="presentation" width="100%" style="border-collapse:collapse">' + items.map(function (it) {
      var w = Math.max(it.v > 0 ? 2 : 0, Math.round(it.v / max * 100)), c = S[it.tono] || S.r;
      return '<tr><td style="width:38%;font-size:11.5px;padding:3px 8px 3px 0;color:#333;white-space:nowrap;overflow:hidden">' + e(it.lab) + '</td>' +
        '<td style="padding:3px 0"><table role="presentation" width="100%" style="border-collapse:collapse"><tr>' +
        (w ? '<td style="width:' + w + '%;background:' + c[1] + ';height:16px;border-radius:3px"></td>' : '') +
        '<td style="padding-left:6px;font-size:11.5px;font-weight:bold;color:' + c[1] + ';white-space:nowrap">' + e(it.txt) + '</td></tr></table></td></tr>';
    }).join('') + '</table>';
  };
  var ETN = ['Vencidas con saldo', 'Notificada a Compras', 'Notificada al proveedor', 'Con descargos del proveedor', 'Con decisión de Abastos', 'Decisión notificada'];
  var nVen = R.venc.length || 1;

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:980px">' +
    (prueba ? '<div style="background:#FAEEDA;color:#854F0B;border-radius:6px;padding:6px 10px;font-size:12px;margin-bottom:8px">PRUEBA · lista real: ' +
      e((cfg && cfg.to.length ? cfg.to.join(', ') : 'sin destinatario PARA') + (cfg && cfg.cc.length ? ' · CC ' + cfg.cc.join(', ') : '')) + '</div>' : '') +
    '<table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:12px;border-bottom:2px solid #1E5A9E"><tr>' +
      '<td style="width:54px;vertical-align:middle;padding:0 10px 8px 0"><img src="' + SEG.LOGO + '" alt="CSS" width="46" height="46" style="display:block"></td>' +
      '<td style="vertical-align:middle;padding-bottom:8px"><div style="font-size:15px;font-weight:bold;color:#1E5A9E">Caja de Seguro Social</div><div style="font-size:12px;color:#555">Dirección Nacional de Logística · Torre de Control</div></td>' +
      '<td style="text-align:right;vertical-align:middle;padding-bottom:8px;font-size:11px;color:#666">Libro de Seguimiento al<br><b>' + segFechaTxt_(R.corte) + '</b><br>calculado al ' + segFechaTxt_(R.hoy) + '</td></tr></table>' +
    '<div style="font-size:18px;font-weight:bold;color:#1E5A9E;margin-bottom:2px">Cumplimiento de entregas de proveedores · acciones del día</div>' +
    '<div style="font-size:12px;color:#555;margin-bottom:10px">Cada nota de solicitud de entrega a un CEDIS, del libro de Incumplimientos del Departamento de Seguimiento. Verde: al día · ámbar: atender · rojo: atrasado.</div>';

  html += '<table role="presentation" width="100%" style="border-collapse:collapse;table-layout:fixed"><tr>' +
    tile('Notas vencidas con saldo', nf(R.venc.length), 'su fecha de entrega ya pasó', 'r', 'venc') +
    tile('Saldo vencido', segMillones_(R.vencValor), 'saldo × precio unitario', 'r', 'valor') +
    tile('Sin notificar a Compras', nf(R.sinN.length), 'vencidas hace más de ' + SEG.SIN_NOT_DIAS + ' días', R.sinN.length ? 'a' : 'v', 'sinN') +
    tile('Vencen en ' + SEG.VENTANA_AV + ' días', nf(R.prox.length), 'con saldo, aún en plazo', 'n', 'prox') +
    '</tr></table>';

  html += h2('Dónde se detiene el seguimiento de las vencidas', 'cada etapa cuenta las notas que llegaron al menos hasta ahí') +
    '<table role="presentation" width="100%" style="border-collapse:collapse;table-layout:fixed"><tr>' +
    R.cad.map(function (v, k) {
      return nodo(ETN[k], nf(v), k === 0 ? segMillones_(R.vencValor) : Math.round(v / nVen * 100) + ' % de las vencidas', k === 0 ? 'r' : (k < 3 ? 'a' : (k < 5 ? 'n' : 'v')));
    }).join(flecha) + '</tr></table>';

  var acc = segIncAcciones_(R);
  html += h2('Acciones de hoy', 'número · qué hacer · quién') + (acc.length ? '<table role="presentation" width="100%" style="border-collapse:collapse">' + acc.map(function (a) {
    var c = S[a.tono] || S.n;
    return '<tr><td style="padding:3px 0"><table role="presentation" width="100%" style="border-collapse:collapse;background:' + c[0] + ';border-radius:6px"><tr>' +
      '<td style="width:74px;text-align:center;font-family:Consolas,monospace;font-size:20px;font-weight:bold;color:' + c[1] + ';padding:6px 4px">' + a.n + '</td>' +
      '<td style="font-size:12.5px;color:#1a1a1a;padding:6px 6px">' + e(a.corto) + (a.valor ? ' <b>(' + segMillones_(a.valor) + ')</b>' : '') + '</td>' +
      '<td style="width:190px;text-align:right;padding:6px 10px"><span style="background:#fff;color:' + c[1] + ';font-weight:bold;font-size:11px;border-radius:10px;padding:2px 8px;white-space:nowrap">' + e(a.resp) + '</span></td>' +
      '</tr></table></td></tr>';
  }).join('') + '</table>' : '<div style="background:#E1F5EE;color:#0F6E56;border-radius:6px;padding:8px 11px;font-size:12.5px">Sin acciones pendientes.</div>');

  html += h2('Para empezar hoy', 'lo más urgente de cada lista');
  if (R.sinN.length) html += '<div style="font-size:12.5px;font-weight:bold;color:#1E5A9E;margin:6px 0 4px">1 · Notificar a Compras · mayor saldo primero</div>' +
    tabla([th('Días'), th('Medicamento o insumo', 'left'), th('Proveedor', 'left'), th('CEDIS'), th('Orden · nota'), th('Saldo B/.')],
      R.sinN.slice(0, TOP).map(function (r, i) { return zebra(i) + td(chip(nf(r.atraso), 'r')) + td('<b>' + e(r.cod) + '</b> ' + e(String(r.desc || '').slice(0, 34)), 'left') +
        td(e(String(r.prov).slice(0, 28)), 'left') + td(e(r.cedis)) + td(e(r.req) + ' · ' + e(r.nota)) + td(nf(r.valor), 'right') + '</tr>'; })) + mas(R.sinN.length, 'Sin notificar');
  if (R.sinP.length) html += '<div style="font-size:12.5px;font-weight:bold;color:#1E5A9E;margin:12px 0 4px">2 · Notificar al proveedor</div>' +
    tabla([th('Días'), th('Medicamento o insumo', 'left'), th('Proveedor', 'left'), th('Nota a Compras'), th('Saldo B/.')],
      R.sinP.slice(0, TOP).map(function (r, i) { return zebra(i) + td(chip(nf(r.atraso), 'r')) + td('<b>' + e(r.cod) + '</b> ' + e(String(r.desc || '').slice(0, 34)), 'left') +
        td(e(String(r.prov).slice(0, 28)), 'left') + td(e(r.notC) + (r.fAviso ? ' · ' + segFechaTxt_(r.fAviso) : '')) + td(nf(r.valor), 'right') + '</tr>'; })) + mas(R.sinP.length, 'Sin notificar al proveedor');
  if (R.prox3.length) html += '<div style="font-size:12.5px;font-weight:bold;color:#1E5A9E;margin:12px 0 4px">3 · Aviso preventivo · vencen en 3 días o menos</div>' +
    tabla([th('Vence'), th('Faltan'), th('Medicamento o insumo', 'left'), th('Proveedor', 'left'), th('Saldo (u)'), th('Planificador')],
      R.prox3.slice(0, TOP).map(function (r, i) { return zebra(i) + td(segFechaTxt_(r.venc)) + td(chip(nf(r.faltan) + ' d', r.faltan <= 1 ? 'r' : 'a')) + td('<b>' + e(r.cod) + '</b> ' + e(String(r.desc || '').slice(0, 34)), 'left') +
        td(e(String(r.prov).slice(0, 28)), 'left') + td(nf(r.saldo), 'right') + td(e(r.plan || '—')) + '</tr>'; })) + mas(R.prox3.length, 'Próximos vencimientos');

  html += h2('Proveedores con mayor saldo vencido', 'notas vencidas · saldo · entregas a tiempo en el libro') +
    barras(R.provs.slice(0, 6).map(function (o) {
      return { lab: o.prov.replace(/,? ?S\.?\s?A\.?$/i, ''), v: o.sv, tono: 'r',
               txt: segMillones_(o.sv) + ' · ' + nf(o.v) + ' notas · ' + (o.pt === null ? '—' : Math.round(o.pt * 100) + ' % a tiempo') };
    }), R.provs.length ? R.provs[0].sv : 1);

  html += cinta('El Excel adjunto trae todas las listas: Acciones, Vencidas, Sin notificar, Sin notificar al proveedor, Próximos vencimientos y Proveedores.');
  html += '<div style="background:#E6F1FB;border-radius:6px;padding:9px 12px;margin-top:16px;font-size:11px;line-height:1.5;color:#233"><b style="color:#185FA5">Cómo se calcula.</b> ' +
    'Recibido = suma de las entradas de la hoja Entradas con la misma orden y la misma nota. Saldo = solicitado − recibido. ' +
    'Una nota con saldo y fecha de entrega anterior a hoy está vencida, aunque su primera entrega haya llegado a tiempo. ' +
    'Días de atraso = hoy − fecha de entrega (o última entrada − fecha de entrega si ya se completó). Saldo B/. = saldo × precio unitario del libro. ' +
    'Etapa: notificada a Compras (columna Q), al proveedor (S), descargos (U), decisión de Abastos (V), decisión notificada (W).</div>' +
    '<div style="font-size:12px;margin-top:10px"><a href="' + SEG.PANEL_INC + '" style="color:#185FA5">Abrir el tablero de Cumplimiento de Entregas</a></div>' +
    '<div style="font-size:11px;color:#888;margin-top:8px">Correo automático de la Dirección Nacional de Logística · se envía cada mañana con el último libro cargado en la Ventanilla Única.</div></div>';
  return html;
}

function segIncExcel_(R) {
  var tmp = SpreadsheetApp.create('_TEMP_CUMPLIMIENTO_' + R.hoy);
  var logo = null; try { logo = UrlFetchApp.fetch(SEG.LOGO).getBlob(); } catch (e0) {}
  var primera = true;
  var hoja = function (nombre, titulo, sub, cab, filas, anchos, txt) {
    var ws;
    if (primera) { ws = tmp.getActiveSheet(); ws.setName(nombre); primera = false; } else ws = tmp.insertSheet(nombre);
    if (logo) { try { ws.insertImage(logo, 1, 1).setWidth(46).setHeight(46); } catch (eL) {} }
    ws.setRowHeight(1, 26); ws.setRowHeight(2, 22);
    ws.getRange(1, 2).setValue('Caja de Seguro Social · Dirección Nacional de Logística').setFontSize(10).setFontColor('#555555');
    ws.getRange(2, 2).setValue(titulo).setFontSize(15).setFontWeight('bold').setFontColor('#1E5A9E');
    ws.getRange(3, 2).setValue(sub).setFontSize(9).setFontStyle('italic').setFontColor('#666666');
    ws.getRange(4, 1, 1, Math.max(cab.length, 2)).setBackground('#1E5A9E'); ws.setRowHeight(4, 3);
    if (txt && filas.length) ws.getRange(7, 1, filas.length, txt).setNumberFormat('@');
    ws.getRange(6, 1, 1, cab.length).setValues([cab]).setBackground('#1E5A9E').setFontColor('#FFFFFF').setFontWeight('bold')
      .setFontSize(9).setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle');
    ws.setRowHeight(6, 36);
    if (filas.length) {
      ws.getRange(7, 1, filas.length, cab.length).setValues(filas).setFontSize(10);
      ws.getRange(6, 1, filas.length + 1, cab.length).createFilter();
    } else ws.getRange(7, 1).setValue('Sin casos en este corte.').setFontStyle('italic').setFontColor('#666666');
    (anchos || []).forEach(function (w, j) { ws.setColumnWidth(j + 1, w); });
    ws.setFrozenRows(6);
  };
  var s = function (v) { return v === null || v === undefined ? '' : String(v); };
  var ETN = ['0 · Sin notificar a Compras', '1 · Notificada a Compras', '2 · Notificada al proveedor', '3 · Con descargos', '4 · Con decisión de Abastos', '5 · Decisión notificada'];
  var sub = 'Libro de Incumplimientos de Seguimiento al ' + R.corte + ' · calculado al ' + R.hoy + '.';
  var cabN = ['Código', 'Medicamento o insumo', 'Inventario', 'CEDIS', 'Proveedor', 'Orden', 'Nota', 'Vencía', 'Solicitado (u)', 'Recibido (u)', 'Saldo (u)', 'Saldo B/.', 'Días de atraso', 'Resultado', 'Etapa del seguimiento', 'Nota a Compras', 'Planificador'];
  var filaN = function (r) { return [s(r.cod), s(r.desc), s(r.inv), s(r.cedis), s(r.prov), s(r.req), s(r.nota), s(r.venc), r.qty || 0, r.recib || 0, r.saldo || 0, Math.round(r.valor || 0), r.atraso, r.est, ETN[r.et] || '', s(r.notC), s(r.plan)]; };
  var anN = [100, 300, 120, 60, 240, 110, 70, 90, 100, 100, 90, 100, 80, 170, 190, 110, 90];
  var ord = function (a) { return a.slice().sort(function (x, y) { return y.valor - x.valor; }); };
  try {
    hoja('Acciones', 'Cumplimiento de entregas · acciones del día', sub, ['#', 'Responsable', 'Acción'],
      segIncAcciones_(R).map(function (a, i) { return [i + 1, a.resp, a.txt]; }), [40, 200, 820]);
    hoja('Vencidas', 'Notas vencidas con saldo', sub + ' Ordenadas por saldo en balboas.', cabN, ord(R.venc).map(filaN), anN, 8);
    hoja('Sin notificar', 'Vencidas hace más de ' + SEG.SIN_NOT_DIAS + ' días sin nota a Compras', sub, cabN, R.sinN.map(filaN), anN, 8);
    hoja('Sin notificar al proveedor', 'Notificadas a Compras y no al proveedor', sub, cabN, R.sinP.map(filaN), anN, 8);
    hoja('Próximos vencimientos', 'Notas con saldo que vencen en ' + SEG.VENTANA_AV + ' días', sub,
      ['Vence', 'Faltan (días)', 'Código', 'Medicamento o insumo', 'CEDIS', 'Proveedor', 'Orden', 'Nota', 'Saldo (u)', 'Saldo B/.', 'Planificador'],
      R.prox.map(function (r) { return [s(r.venc), r.faltan, s(r.cod), s(r.desc), s(r.cedis), s(r.prov), s(r.req), s(r.nota), r.saldo || 0, Math.round(r.valor || 0), s(r.plan)]; }),
      [90, 80, 100, 300, 60, 240, 110, 70, 90, 100, 90], 8);
    hoja('Proveedores', 'Proveedores con notas vencidas', sub + ' Ordenados por saldo vencido.',
      ['Proveedor', 'Notas en el libro', 'Cumplidas a tiempo', 'Cumplidas con atraso', '% a tiempo', 'Vencidas', 'Saldo vencido B/.'],
      R.provs.map(function (o) { return [o.prov, o.n, o.at, o.ct, o.pt === null ? '' : Math.round(o.pt * 100), o.v, Math.round(o.sv)]; }),
      [300, 110, 110, 120, 80, 80, 130]);
    SpreadsheetApp.flush();
    var blob = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + tmp.getId() + '/export?format=xlsx',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }).getBlob();
    blob.setName('Cumplimiento_entregas_' + R.hoy + '.xlsx');
    return blob;
  } finally {
    try { DriveApp.getFileById(tmp.getId()).setTrashed(true); } catch (e) {}
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  DIAGNOSTICO (solo lee; no publica ni envia)
 * ────────────────────────────────────────────────────────────────────────── */
function segDiagnostico() {
  var L = [];
  try { DriveApp.getFolderById(SEG.RAIZ); L.push('OK  carpeta raíz de la Ventanilla Única'); } catch (e) { L.push('ERR carpeta raíz: ' + e); }
  ['cons', 'inc'].forEach(function (t) {
    try { var a = segArchivoVigente_(t); L.push((a ? 'OK  ' : '--  ') + SEG.CARPETA[t] + ': ' + (a ? a.file.getName() + ' (corte ' + a.fecha + ')' : 'sin archivos todavía')); }
    catch (e) { L.push('ERR ' + SEG.CARPETA[t] + ': ' + e); }
    try { var g = segGitLeer_(SEG.RUTA[t]); L.push('OK  GitHub ' + SEG.GH_REPO + '/' + SEG.RUTA[t] + ': ' + (g && g.obj ? g.obj.rows.length + ' filas, corte ' + g.obj.corte : 'aún no existe')); }
    catch (e) { L.push('ERR GitHub ' + SEG.RUTA[t] + ': ' + e); }
  });
  try { var c = segCfgLeer_(); L.push('OK  CONFIG_ALERTAS: ' + (c.existe ? 'INCUMP_ACTIVO=' + (c.activo ? 'SI' : 'NO') + ' · ' + c.to.length + ' PARA · ' + c.cc.length + ' CC · prueba ' + (c.prueba.join(', ') || '—') + ' · días ' + c.dias : 'faltan las filas INCUMP_* (ejecute segCrearConfigAlertas)')); }
  catch (e) { L.push('ERR CONFIG_ALERTAS: ' + e); }
  L.push('    correo: ' + (typeof kevMandar_ === 'function' ? 'kevMandar_ → correoEnviar_' : (typeof correoEnviar_ === 'function' ? 'correoEnviar_' : 'MailApp')));
  L.push('    activador diario: ' + (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'segIncCorreoDiario'; }) ? 'instalado' : 'no instalado (de esta cuenta)'));
  Logger.log(L.join('\n'));
  return L;
}
