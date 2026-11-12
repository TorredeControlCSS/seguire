/**
 * ============================================================================
 *  EXPEDIENTE DE INCUMPLIMIENTO DE ENTREGA · registro de hitos por PIN
 *  Diego Bethancourth · Torre de Control · DINALOG · CSS
 *  Proyecto: SIGUELO (mismo proyecto de Apps Script que TRAZABILIDAD_RB.gs)
 * ----------------------------------------------------------------------------
 *  Archivo NUEVO. No modifica ninguna función existente.
 *
 *  LIBRO PROPIO: la bitácora NO se guarda en el libro de citas de SIGUELO.
 *  incInstalar() crea un libro aparte, «SIGUELO · Expedientes de
 *  Incumplimiento», y guarda su ID en las Propiedades del script
 *  (INC_LIBRO_ID). Así el libro de citas no suma celdas (límite de 10
 *  millones por libro) y el expediente puede crecer sin afectarlo.
 *
 *  Hojas del libro propio (incInstalar):
 *    INC_USUARIOS  PIN | NOMBRE | CARGO | DIRECCION | ROL | ACTIVO | CORREO | NOTA
 *    INC_EVENTOS   bitácora inmutable de hitos (nunca se borra; se anula)
 *    INC_ACCESOS   auditoría de ingresos por PIN
 *  Cada hoja se recorta a sus columnas para no reservar celdas vacías.
 *
 *  Quién registra (por CARGO, no por persona; titular o suplente con su PIN):
 *    Etapa 2  Informe de incumplimiento ............ Jefe del Departamento de Seguimiento   (Logística)
 *    Etapa 3  Notificación proveedor y afianzadora . Jefe del Departamento de Prórrogas y Multas (Compras)
 *    Etapa 4  Descargos o prórroga ................. Jefe del Departamento de Prórrogas y Multas (Compras)
 *    Etapa 5  Evaluación e instrucción ............. Director de Abasto                    (Logística)
 *    Etapa 6  Resolución y multa ................... Coordinador Legal                     (Dirección Ejecutiva)
 *    Etapa 7  Notificación y ejecución de la fianza  Jefe del Departamento de Prórrogas y Multas (Compras)
 *    ROL = SUPERVISOR registra cualquier etapa y anula con motivo;
 *    ROL = CONSULTA entra pero no registra.
 *
 *  Reglas que hace cumplir el servidor (no dependen del navegador):
 *    1. El usuario sale del PIN.  2. Cada cargo registra solo sus etapas.
 *    3. No se saltan etapas: la que toca sale del libro de Seguimiento más la
 *       bitácora.  4. Documento obligatorio (PDF o foto, 8 MB) en Drive.
 *    5. Fecha del hito: no futura ni anterior al hito previo.
 *    6. Doble envío: el mismo ID_CLIENTE no se graba dos veces.
 *    7. Nada se borra: un supervisor anula con motivo.
 *
 *  INSTALACIÓN (una sola vez):
 *    a) Pegar este archivo en el proyecto de SIGUELO.
 *    b) En TRAZABILIDAD_RB.gs, dentro de trzRuta_(e), como PRIMERA línea:
 *         if (typeof incRuta_ === 'function') { var _inc = incRuta_(e); if (_inc) return _inc; }
 *       y dentro de trzPost_(payload), como PRIMERA línea:
 *         if (typeof incPost_ === 'function') { var _incp = incPost_(payload); if (_incp) return _incp; }
 *       (trzRuta_ y trzPost_ ya están enganchados a doGet y doPost.)
 *    c) Ejecutar incInstalar() desde el editor. Crea el libro, la carpeta de
 *       evidencias y los PIN de prueba por cargo (columna NOTA = PRUEBA).
 *    d) Ejecutar incPrueba() y revisar el registro de ejecución.
 *    e) Implementar > Gestionar implementaciones > editar > Nueva versión
 *       (misma URL /exec).
 *    f) Ejecutar incPublicarAhora() para la primera publicación del JSON.
 *
 *  REVERSIÓN: borrar las dos líneas del paso b) y este archivo. El libro
 *  propio queda como respaldo y no afecta a SIGUELO.
 * ============================================================================
 */

var INC_HOJA_USUARIOS = 'INC_USUARIOS';
var INC_HOJA_EVENTOS  = 'INC_EVENTOS';
var INC_HOJA_ACCESOS  = 'INC_ACCESOS';
var INC_LIBRO_NOMBRE  = 'SIGUELO · Expedientes de Incumplimiento';
var INC_CARPETA_NOMBRE = 'Expedientes de Incumplimiento · Evidencias';
var INC_LIBRO_FUENTE  = 'https://torrecontrolcss.org/seguire/data/cumplimiento_entregas.json';
var INC_GH_PATH       = 'incumplimiento_eventos.json';
var INC_PROP_HASH     = 'INC_HUELLA';
var INC_MAX_BYTES     = 8 * 1024 * 1024;
var INC_MAX_FALLOS    = 15;
var INC_VENTANA_FALLOS = 600;

var INC_COLS_USUARIOS = ['PIN', 'NOMBRE', 'CARGO', 'DIRECCION', 'ROL', 'ACTIVO', 'CORREO', 'NOTA'];
var INC_COLS_EVENTOS = ['TS_SERVIDOR', 'ID_EVENTO', 'ID_CLIENTE', 'EXPEDIENTE', 'OC', 'NOTA', 'RENGLON', 'PROVEEDOR',
  'ETAPA', 'FECHA_HITO', 'USUARIO', 'CARGO', 'DIRECCION', 'OBSERVACION', 'EVIDENCIA_URL', 'EVIDENCIA_NOMBRE',
  'ESTADO', 'ANULADO_POR', 'ANULADO_TS', 'ANULADO_MOTIVO'];
var INC_COLS_ACCESOS = ['TS', 'PIN_TERMINA_EN', 'RESULTADO', 'USUARIO'];

/* Etapas del expediente: [número, cargo que registra, dirección, nombre]. */
var INC_ETAPAS = [
  [1, 'Sistema', 'Dirección Nacional de Logística', 'Nota vencida con saldo'],
  [2, 'Jefe del Departamento de Seguimiento', 'Dirección Nacional de Logística', 'Informe de incumplimiento'],
  [3, 'Jefe del Departamento de Prórrogas y Multas', 'Dirección Nacional de Compras', 'Notificación al proveedor y a la afianzadora'],
  [4, 'Jefe del Departamento de Prórrogas y Multas', 'Dirección Nacional de Compras', 'Descargos o prórroga'],
  [5, 'Director de Abasto', 'Dirección Nacional de Logística', 'Evaluación e instrucción de resolver'],
  [6, 'Coordinador Legal', 'Dirección Ejecutiva Nacional de Administración', 'Resolución administrativa y multa'],
  [7, 'Jefe del Departamento de Prórrogas y Multas', 'Dirección Nacional de Compras', 'Notificación y ejecución de la fianza']
];

/* ------------------------------------------------------------------ */
/*  Enrutadores (devuelven null si la acción no es de este módulo)      */
/* ------------------------------------------------------------------ */

function incRuta_(e) {
  var p = (e && e.parameter) || {};
  var a = String(p.action || '');
  if (a.indexOf('inc') !== 0) return null;
  try {
    if (a === 'incEventos') return incEventos_(String(p.exp || ''));
    if (a === 'incEtapas')  return { success: true, etapas: INC_ETAPAS };
    return null;
  } catch (err) {
    return { success: false, error: 'Error interno: ' + String(err && err.message || err) };
  }
}

function incPost_(payload) {
  var a = String((payload && payload.action) || '');
  if (a.indexOf('inc') !== 0) return null;
  try {
    var d = payload.data || {};
    if (a === 'incLogin')     return incLogin_(d);
    if (a === 'incRegistrar') return incRegistrar_(d);
    if (a === 'incAnular')    return incAnular_(d);
    return { success: false, error: 'Acción del expediente no reconocida.' };
  } catch (err) {
    return { success: false, error: 'Error interno: ' + String(err && err.message || err) };
  }
}

/* ------------------------------------------------------------------ */
/*  Libro propio y hojas                                                */
/* ------------------------------------------------------------------ */

function incLibro_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INC_LIBRO_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { Logger.log('INC_LIBRO_ID inválido: ' + e); } }
  var ss = SpreadsheetApp.create(INC_LIBRO_NOMBRE);
  // El libro nuevo se mueve junto al libro de citas, si esta cuenta puede.
  try {
    var padre = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
    if (padre.hasNext()) DriveApp.getFileById(ss.getId()).moveTo(padre.next());
  } catch (e) { Logger.log('El libro queda en Mi unidad: ' + e); }
  props.setProperty('INC_LIBRO_ID', ss.getId());
  Logger.log('Libro creado: ' + ss.getUrl());
  return ss;
}

function incHoja_(nombre, encabezados) {
  var ultimoError = null;
  for (var intento = 1; intento <= 3; intento++) {
    try {
      var ss = incLibro_();
      var sh = ss.getSheetByName(nombre);
      if (!sh) {
        sh = ss.insertSheet(nombre);
        // Recorta a las columnas de la hoja: no se reservan celdas vacías.
        var sobra = sh.getMaxColumns() - encabezados.length;
        if (sobra > 0) sh.deleteColumns(encabezados.length + 1, sobra);
        if (sh.getMaxRows() > 200) sh.deleteRows(201, sh.getMaxRows() - 200);
      }
      if (sh.getLastColumn() === 0 || String(sh.getRange(1, 1).getValue()).trim() === '') {
        sh.getRange(1, 1, 1, encabezados.length).setValues([encabezados]).setFontWeight('bold');
        sh.setFrozenRows(1);
        SpreadsheetApp.flush();
      }
      return sh;
    } catch (e) {
      ultimoError = e;
      Utilities.sleep(1500 * intento);
    }
  }
  throw ultimoError;
}

function incIdx_(hdr) {
  var m = {};
  for (var i = 0; i < hdr.length; i++) m[String(hdr[i] || '').trim().toUpperCase()] = i;
  return m;
}

function incNorm_(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
}

function incFmt_(d, conHora) {
  if (!(d instanceof Date)) return String(d || '');
  return Utilities.formatDate(d, 'America/Panama', conHora ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd');
}

/* ------------------------------------------------------------------ */
/*  Usuarios y PIN                                                      */
/* ------------------------------------------------------------------ */

function incBuscarUsuario_(pin) {
  pin = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(pin)) return null;
  var v = incHoja_(INC_HOJA_USUARIOS, INC_COLS_USUARIOS).getDataRange().getValues();
  if (v.length < 2) return null;
  var c = incIdx_(v[0]);
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][c.PIN]).trim() !== pin) continue;
    if (String(v[i][c.ACTIVO] || 'SI').trim().toUpperCase() === 'NO') return { inactivo: true };
    return {
      nombre: String(v[i][c.NOMBRE] || '').trim(),
      cargo: String(v[i][c.CARGO] || '').trim(),
      direccion: String(v[i][c.DIRECCION] || '').trim(),
      rol: String(v[i][c.ROL] || 'OPERADOR').trim().toUpperCase()
    };
  }
  return null;
}

function incEtapasDe_(u) {
  if (u.rol === 'SUPERVISOR') return [2, 3, 4, 5, 6, 7];
  if (u.rol === 'CONSULTA') return [];
  var c = incNorm_(u.cargo);
  return INC_ETAPAS.filter(function (e) { return e[0] > 1 && incNorm_(e[1]) === c; }).map(function (e) { return e[0]; });
}

function incAuditar_(pin, resultado, usuario) {
  try { incHoja_(INC_HOJA_ACCESOS, INC_COLS_ACCESOS).appendRow([new Date(), '…' + String(pin || '').slice(-2), resultado, usuario || '']); } catch (e) {}
}

function incFreno_(sumar) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('inc_fallos') || 0);
  if (sumar) { n++; cache.put('inc_fallos', String(n), INC_VENTANA_FALLOS); }
  return n >= INC_MAX_FALLOS;
}

function incAutenticar_(pin) {
  if (incFreno_(false)) return { error: 'Demasiados intentos fallidos. Espere 10 minutos.' };
  var u = incBuscarUsuario_(pin);
  if (!u) { incFreno_(true); incAuditar_(pin, 'PIN_INVALIDO', ''); return { error: 'PIN incorrecto.' }; }
  if (u.inactivo) { incAuditar_(pin, 'INACTIVO', ''); return { error: 'Usuario inactivo. Consulte a la Torre de Control.' }; }
  if (!u.nombre || !u.cargo) return { error: 'El usuario no tiene nombre o cargo cargados en INC_USUARIOS.' };
  return { usuario: u };
}

function incLogin_(d) {
  var r = incAutenticar_(d.pin);
  if (r.error) return { success: false, error: r.error };
  incAuditar_(d.pin, 'INGRESO', r.usuario.nombre);
  return { success: true, nombre: r.usuario.nombre, cargo: r.usuario.cargo, direccion: r.usuario.direccion,
    rol: r.usuario.rol, etapas: incEtapasDe_(r.usuario) };
}

/* ------------------------------------------------------------------ */
/*  Bitácora                                                            */
/* ------------------------------------------------------------------ */

function incLeerEventos_(exp) {
  var v = incHoja_(INC_HOJA_EVENTOS, INC_COLS_EVENTOS).getDataRange().getValues();
  var c = incIdx_(v[0]), out = [];
  for (var i = 1; i < v.length; i++) {
    if (exp && String(v[i][c.EXPEDIENTE]) !== exp) continue;
    out.push({
      id: String(v[i][c.ID_EVENTO]), idCliente: String(v[i][c.ID_CLIENTE] || ''), exp: String(v[i][c.EXPEDIENTE]),
      etapa: Number(v[i][c.ETAPA]), fecha: incFmt_(v[i][c.FECHA_HITO]), ts: incFmt_(v[i][c.TS_SERVIDOR], true),
      quien: String(v[i][c.USUARIO] || ''), cargo: String(v[i][c.CARGO] || ''), direccion: String(v[i][c.DIRECCION] || ''),
      obs: String(v[i][c.OBSERVACION] || ''), evidUrl: String(v[i][c.EVIDENCIA_URL] || ''), evid: String(v[i][c.EVIDENCIA_NOMBRE] || ''),
      estado: String(v[i][c.ESTADO] || 'VIGENTE'), anuladoPor: String(v[i][c.ANULADO_POR] || ''), anuladoMotivo: String(v[i][c.ANULADO_MOTIVO] || '')
    });
  }
  return out;
}

function incEventos_(exp) {
  var ev = incLeerEventos_(exp).map(function (x) { delete x.idCliente; return x; });
  return { success: true, exp: exp || null, generado: incFmt_(new Date(), true), eventos: ev };
}

/* La nota en el libro de Seguimiento publicado: de ahí sale la etapa base. */
function incNotaDelLibro_(exp) {
  var r = UrlFetchApp.fetch(INC_LIBRO_FUENTE + '?_=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return { error: 'No se pudo leer el libro de Incumplimientos publicado.' };
  var D = JSON.parse(r.getContentText()), C = D.cols, ix = {};
  C.forEach(function (k, i) { ix[k] = i; });
  for (var i = 0; i < D.rows.length; i++) {
    var x = D.rows[i];
    var id = 'EXP-' + x[ix.req] + '-' + String(x[ix.nota]).replace(/[^0-9A-Za-z.]/g, '');
    if (id !== exp) continue;
    return { req: String(x[ix.req]), nota: String(x[ix.nota]), cod: String(x[ix.cod] || ''), prov: String(x[ix.prov] || ''),
      venc: String(x[ix.venc] || ''), saldo: Number(x[ix.saldo] || 0), et: Math.min(5, Number(x[ix.et] || 0)),
      fAviso: String(x[ix.fAviso] || ''), fNotP: String(x[ix.fNotP] || '') };
  }
  return { error: 'El expediente ' + exp + ' no está en el libro de Incumplimientos publicado.' };
}

/* Etapa que toca y fecha desde la que se cuenta: libro + bitácora vigente. */
function incEstado_(nota, eventos) {
  var act = nota.et + 2;
  var ini = [nota.venc, nota.fAviso || nota.venc, nota.fNotP || nota.fAviso || nota.venc][Math.min(2, nota.et)] || nota.venc;
  eventos.filter(function (e) { return e.estado !== 'ANULADO'; })
    .sort(function (a, b) { return a.etapa - b.etapa; })
    .forEach(function (e) { if (e.etapa === act) { act++; ini = e.fecha; } });
  return { act: Math.min(act, 8), ini: ini };
}

/* ------------------------------------------------------------------ */
/*  Registrar un hito                                                   */
/* ------------------------------------------------------------------ */

function incRegistrar_(d) {
  var auth = incAutenticar_(d.pin);
  if (auth.error) return { success: false, error: auth.error };
  var u = auth.usuario;

  var exp = String(d.exp || '').trim();
  if (!/^EXP-\d{6,12}-[0-9A-Za-z.]+$/.test(exp)) return { success: false, error: 'Identificador de expediente no válido.' };
  var etapa = Number(d.etapa);
  if (!(etapa >= 2 && etapa <= 7)) return { success: false, error: 'Etapa no válida.' };
  if (incEtapasDe_(u).indexOf(etapa) < 0) {
    return { success: false, error: 'La etapa ' + etapa + ' la registra el ' + INC_ETAPAS[etapa - 1][1] + '; su usuario es ' + u.cargo + '.' };
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d.fecha || ''));
  if (!m) return { success: false, error: 'Fecha del hito no válida.' };
  var fecha = m[0];
  if (fecha > incFmt_(new Date())) return { success: false, error: 'La fecha del hito no puede ser futura.' };

  if (!d.evidencia || !d.evidencia.base64) return { success: false, error: 'Adjunte el documento firmado: sin él la etapa no se registra.' };
  var bytes = Utilities.base64Decode(String(d.evidencia.base64));
  if (bytes.length > INC_MAX_BYTES) return { success: false, error: 'El documento supera 8 MB.' };
  var mime = String(d.evidencia.mime || 'application/octet-stream');
  if (!/^image\/|^application\/pdf$/.test(mime)) return { success: false, error: 'El documento debe ser PDF o foto.' };

  var nota = incNotaDelLibro_(exp);
  if (nota.error) return { success: false, error: nota.error };
  var idCliente = String(d.idCliente || '').slice(0, 64);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, error: 'El sistema está ocupado; reintente en unos segundos.' };
  try {
    var previos = incLeerEventos_(exp);
    if (idCliente) {
      for (var k = 0; k < previos.length; k++) {
        if (previos[k].idCliente === idCliente) return { success: true, duplicado: true, id: previos[k].id, mensaje: 'Esta etapa ya estaba registrada.' };
      }
    }
    var st = incEstado_(nota, previos);
    if (st.act > 7) return { success: false, error: 'El expediente ya completó sus siete etapas.' };
    if (st.act !== etapa) {
      return { success: false, error: 'Ahora le toca la etapa ' + st.act + ' (' + INC_ETAPAS[st.act - 1][3] + '). No se pueden saltar etapas.' };
    }
    if (st.ini && fecha < st.ini) return { success: false, error: 'La fecha es anterior al hito previo (' + st.ini + ').' };

    var raiz = incCarpeta_();
    var cExp = incSub_(raiz, exp.replace(/[\/\\:*?"<>|]/g, '-'));
    var ext = mime.indexOf('pdf') >= 0 ? '.pdf' : (mime.indexOf('png') >= 0 ? '.png' : '.jpg');
    var nombre = exp + '_E' + etapa + '_' + fecha.replace(/-/g, '') + ext;
    var archivo = cExp.createFile(Utilities.newBlob(bytes, mime, nombre));

    var idEv = 'INC-' + Utilities.formatDate(new Date(), 'America/Panama', 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random() * 1000);
    var fila = { TS_SERVIDOR: new Date(), ID_EVENTO: idEv, ID_CLIENTE: idCliente, EXPEDIENTE: exp, OC: nota.req, NOTA: nota.nota,
      RENGLON: nota.cod, PROVEEDOR: nota.prov, ETAPA: etapa, FECHA_HITO: fecha, USUARIO: u.nombre, CARGO: u.cargo,
      DIRECCION: u.direccion, OBSERVACION: String(d.obs || '').slice(0, 500), EVIDENCIA_URL: archivo.getUrl(),
      EVIDENCIA_NOMBRE: nombre, ESTADO: 'VIGENTE' };
    var sh = incHoja_(INC_HOJA_EVENTOS, INC_COLS_EVENTOS);
    sh.appendRow(INC_COLS_EVENTOS.map(function (h) { var x = fila[h]; return x == null ? '' : x; }));
    sh.getRange(sh.getLastRow(), INC_COLS_EVENTOS.indexOf('FECHA_HITO') + 1).setNumberFormat('@').setValue(fecha);
    SpreadsheetApp.flush();
    try { incPublicar_(false); } catch (eP) { Logger.log('incPublicar_: ' + eP); }
    return { success: true, id: idEv, evidUrl: archivo.getUrl(), mensaje: 'Etapa ' + etapa + ' registrada.' };
  } finally {
    lock.releaseLock();
  }
}

function incCarpeta_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INC_CARPETA_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var carpeta = null;
  try {
    var padre = DriveApp.getFileById(incLibro_().getId()).getParents();
    if (padre.hasNext()) carpeta = incSub_(padre.next(), INC_CARPETA_NOMBRE);
  } catch (e) {}
  if (!carpeta) {
    var it = DriveApp.getRootFolder().getFoldersByName(INC_CARPETA_NOMBRE);
    carpeta = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(INC_CARPETA_NOMBRE);
  }
  props.setProperty('INC_CARPETA_ID', carpeta.getId());
  return carpeta;
}

function incSub_(padre, nombre) {
  var it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

/* ------------------------------------------------------------------ */
/*  Anular (solo SUPERVISOR)                                            */
/* ------------------------------------------------------------------ */

function incAnular_(d) {
  var auth = incAutenticar_(d.pin);
  if (auth.error) return { success: false, error: auth.error };
  if (auth.usuario.rol !== 'SUPERVISOR') return { success: false, error: 'Solo un supervisor puede anular un registro.' };
  var motivo = String(d.motivo || '').trim();
  if (!motivo) return { success: false, error: 'Indique el motivo de la anulación.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, error: 'El sistema está ocupado; reintente.' };
  try {
    var sh = incHoja_(INC_HOJA_EVENTOS, INC_COLS_EVENTOS);
    var v = sh.getDataRange().getValues(), c = incIdx_(v[0]);
    for (var i = 1; i < v.length; i++) {
      if (String(v[i][c.ID_EVENTO]) !== String(d.id || '')) continue;
      if (String(v[i][c.ESTADO]) === 'ANULADO') return { success: false, error: 'Ese registro ya estaba anulado.' };
      sh.getRange(i + 1, c.ESTADO + 1, 1, 4).setValues([['ANULADO', auth.usuario.nombre, new Date(), motivo.slice(0, 300)]]);
      SpreadsheetApp.flush();
      try { incPublicar_(false); } catch (eP) {}
      return { success: true, mensaje: 'Registro anulado. Queda en la bitácora como ANULADO.' };
    }
    return { success: false, error: 'No se encontró el registro.' };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/*  Publicación a GitHub Pages (el tablero lee este JSON)               */
/* ------------------------------------------------------------------ */

function incPublicar_(forzar) {
  var props = PropertiesService.getScriptProperties(), token = props.getProperty('GH_TOKEN');
  if (!token) return { success: false, error: 'Falta GH_TOKEN en las propiedades del script.' };
  var owner = (typeof SALDOS_GH_OWNER !== 'undefined') ? SALDOS_GH_OWNER : 'TorredeControlCSS';
  var repo = (typeof SALDOS_GH_REPO !== 'undefined') ? SALDOS_GH_REPO : 'SIGUELO';
  var rama = (typeof SALDOS_GH_BRANCH !== 'undefined') ? SALDOS_GH_BRANCH : 'main';
  var ev = incLeerEventos_('').map(function (x) { delete x.idCliente; return x; });
  var cuerpo = JSON.stringify(ev);
  var huella = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, cuerpo, Utilities.Charset.UTF_8));
  if (!forzar && props.getProperty(INC_PROP_HASH) === huella) return { success: true, sinCambios: true, filas: ev.length };
  var obj = { _meta: { fuente: 'INC_EVENTOS · bitácora del Expediente de Incumplimiento · SIGUELO', filas: ev.length,
    generado: Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm') + ' PTY' }, eventos: ev };
  var api = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + INC_GH_PATH;
  var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, sha = null;
  try {
    var g = UrlFetchApp.fetch(api + '?ref=' + rama, { method: 'get', headers: headers, muteHttpExceptions: true });
    if (g.getResponseCode() === 200) sha = JSON.parse(g.getContentText()).sha;
  } catch (e) {}
  var payload = { message: 'Actualizar ' + INC_GH_PATH + ' (' + obj._meta.generado + ')',
    content: Utilities.base64Encode(JSON.stringify(obj), Utilities.Charset.UTF_8), branch: rama };
  if (sha) payload.sha = sha;
  var p = UrlFetchApp.fetch(api, { method: 'put', headers: headers, contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (p.getResponseCode() === 200 || p.getResponseCode() === 201) { props.setProperty(INC_PROP_HASH, huella); return { success: true, filas: ev.length }; }
  return { success: false, error: 'GitHub respondió ' + p.getResponseCode() + ': ' + p.getContentText().slice(0, 300) };
}

function incPublicarAhora() {
  var r = incPublicar_(true);
  Logger.log(r.success ? (INC_GH_PATH + ' publicado: ' + r.filas + ' registros.') : ('No publicado: ' + r.error));
  return r;
}

/* ------------------------------------------------------------------ */
/*  Instalación y prueba (ejecutar desde el editor)                     */
/* ------------------------------------------------------------------ */

function incInstalar() {
  var ss = incLibro_();
  var su = incHoja_(INC_HOJA_USUARIOS, INC_COLS_USUARIOS);
  incHoja_(INC_HOJA_EVENTOS, INC_COLS_EVENTOS);
  incHoja_(INC_HOJA_ACCESOS, INC_COLS_ACCESOS);
  var h1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (h1 && ss.getSheets().length > 1) ss.deleteSheet(h1);

  var cargos = [];
  INC_ETAPAS.forEach(function (e) { if (e[0] > 1 && cargos.indexOf(e[1]) < 0) cargos.push(e[1]); });
  cargos = cargos.concat(['Director Nacional de Logística', 'Director Nacional de Compras', 'Directora Ejecutiva Nacional de Administración', 'Torre de Control']);
  var dirs = ['Dirección Nacional de Logística', 'Dirección Nacional de Compras', 'Dirección Ejecutiva Nacional de Administración'];
  su.getRange('A2:A200').setNumberFormat('@');
  su.getRange('C2:C200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(cargos, true).build());
  su.getRange('D2:D200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(dirs, true).build());
  su.getRange('E2:E200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['OPERADOR', 'SUPERVISOR', 'CONSULTA'], true).build());
  su.getRange('F2:F200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());

  // PIN de prueba por cargo (NOTA = PRUEBA). Reemplazar por los titulares y suplentes validados.
  if (su.getLastRow() < 2) {
    su.getRange(2, 1, 8, INC_COLS_USUARIOS.length).setValues([
      ['710002', 'PRUEBA Seguimiento', 'Jefe del Departamento de Seguimiento', dirs[0], 'OPERADOR', 'SI', '', 'PRUEBA'],
      ['710003', 'PRUEBA Prórrogas y Multas', 'Jefe del Departamento de Prórrogas y Multas', dirs[1], 'OPERADOR', 'SI', '', 'PRUEBA'],
      ['710005', 'PRUEBA Abasto', 'Director de Abasto', dirs[0], 'OPERADOR', 'SI', '', 'PRUEBA'],
      ['710006', 'PRUEBA Coordinación Legal', 'Coordinador Legal', dirs[2], 'OPERADOR', 'SI', '', 'PRUEBA'],
      ['710010', 'PRUEBA Dirección de Logística', 'Director Nacional de Logística', dirs[0], 'SUPERVISOR', 'SI', '', 'PRUEBA'],
      ['710020', 'PRUEBA Dirección de Compras', 'Director Nacional de Compras', dirs[1], 'CONSULTA', 'SI', '', 'PRUEBA'],
      ['710030', 'PRUEBA Dirección Ejecutiva', 'Directora Ejecutiva Nacional de Administración', dirs[2], 'SUPERVISOR', 'SI', '', 'PRUEBA'],
      ['710099', 'PRUEBA Torre de Control', 'Torre de Control', dirs[0], 'SUPERVISOR', 'SI', '', 'PRUEBA']
    ]);
  }
  SpreadsheetApp.flush();
  [INC_HOJA_USUARIOS, INC_HOJA_EVENTOS, INC_HOJA_ACCESOS].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
    var pr = sh.protect().setDescription('Expediente de Incumplimiento · solo script y Torre de Control');
    pr.removeEditors(pr.getEditors());
    if (pr.canDomainEdit()) pr.setDomainEdit(false);
  });
  incCarpeta_();
  Logger.log('Listo. Libro: ' + ss.getUrl() + ' · celdas reservadas: ' + ss.getSheets().reduce(function (a, s) { return a + s.getMaxRows() * s.getMaxColumns(); }, 0));
}

/* Prueba con el primer expediente del libro que espera la etapa 2. Usa el PIN de
   prueba de supervisor; registra y anula, y deja ambas filas en la bitácora. */
function incPrueba() {
  var r = UrlFetchApp.fetch(INC_LIBRO_FUENTE, { muteHttpExceptions: true });
  var D = JSON.parse(r.getContentText()), ix = {};
  D.cols.forEach(function (k, i) { ix[k] = i; });
  var hoy = incFmt_(new Date()), exp = null;
  for (var i = 0; i < D.rows.length; i++) {
    var x = D.rows[i];
    if (x[ix.venc] && x[ix.venc] < hoy && Number(x[ix.saldo]) > 0 && Number(x[ix.et] || 0) === 0) {
      exp = 'EXP-' + x[ix.req] + '-' + String(x[ix.nota]).replace(/[^0-9A-Za-z.]/g, ''); break;
    }
  }
  Logger.log('expediente de prueba: ' + exp);
  var png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  var ev = { base64: png, mime: 'image/png', nombre: 'prueba.png' };
  Logger.log('login supervisor: ' + JSON.stringify(incLogin_({ pin: '710099' })));
  Logger.log('cargo equivocado (debe fallar): ' + JSON.stringify(incRegistrar_({ pin: '710005', exp: exp, etapa: 2, fecha: hoy, evidencia: ev })));
  Logger.log('saltar etapa (debe fallar): ' + JSON.stringify(incRegistrar_({ pin: '710099', exp: exp, etapa: 3, fecha: hoy, evidencia: ev })));
  var r2 = incRegistrar_({ pin: '710002', exp: exp, etapa: 2, fecha: hoy, idCliente: 'prueba-inc-1', obs: 'PRUEBA', evidencia: ev });
  Logger.log('etapa 2 por Seguimiento: ' + JSON.stringify(r2));
  Logger.log('doble envío (debe decir duplicado): ' + JSON.stringify(incRegistrar_({ pin: '710002', exp: exp, etapa: 2, fecha: hoy, idCliente: 'prueba-inc-1', evidencia: ev })));
  if (r2.success) Logger.log('anular: ' + JSON.stringify(incAnular_({ pin: '710099', id: r2.id, motivo: 'PRUEBA de instalación' })));
  Logger.log('publicar: ' + JSON.stringify(incPublicar_(true)));
}
