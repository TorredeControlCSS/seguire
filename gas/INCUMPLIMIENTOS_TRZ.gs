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
    try { incAvisoEtapa_(exp, nota, etapa, fecha, u); } catch (eA) { Logger.log('incAvisoEtapa_: ' + eA); }
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

/* ==================================================================== */
/*  CORREO DIARIO DE SEGUIMIENTO (lunes a viernes, 7:00 a. m. Panamá)    */
/* -------------------------------------------------------------------- */
/*  Cada cargo recibe solo los expedientes que esperan SU etapa, con     */
/*  rojo y ámbar primero y el enlace directo a la ficha para registrar.  */
/*  Los SUPERVISOR y CONSULTA reciben el resumen de las tres direcciones.*/
/*                                                                      */
/*  Propiedades del script:                                             */
/*    INC_CORREO_MODO    PRUEBA (por defecto) | REAL | APAGADO          */
/*    INC_CORREO_PRUEBA  correo que recibe todo en PRUEBA (si falta, la  */
/*                       cuenta que corre el script)                     */
/*  En PRUEBA cada correo llega a INC_CORREO_PRUEBA con el cargo en el   */
/*  asunto y la lista de quiénes lo recibirían en REAL. Pasa a REAL      */
/*  cuando la Directora valide las personas y estén en INC_USUARIOS con  */
/*  su CORREO (las filas con NOTA = PRUEBA nunca reciben correo).        */
/*                                                                      */
/*  Además: aviso INMEDIATO al cargo que sigue cuando alguien registra   */
/*  su etapa (incAvisoEtapa_), y escalamiento al director de la         */
/*  dirección el primer día en que un expediente pasa su plazo.          */
/*  Instalación: ejecutar incCorreoInstalar() una vez (crea el disparador*/
/*  diario). Vista previa: incCorreoVistaPrevia().                      */
/* ==================================================================== */

var INC_TABLERO = 'https://torrecontrolcss.org/seguire/incumplimientos.html';
var INC_SISCOMP = 'https://torrecontrolcss.org/seguire/data/siscomp_cruce.json';
var INC_LOGO = 'https://torrecontrolcss.org/seguire/icons/icon-192.png';
var INC_ANTECED = 'https://torrecontrolcss.org/seguire/data/antecedentes.json';
var INC_PLAZOS = { 1: 0, 2: 2, 3: 3, 4: 5, 5: 10, 6: null, 7: 3 };
var INC_SEM = { r: ['Vencido', '#c83a3a', '#fbe3e3'], a: ['Por vencer', '#a87500', '#fff4d6'], v: ['Dentro del plazo', '#2f8a3e', '#e3f4e6'], g: ['Sin plazo acordado', '#5f6b78', '#eef1f4'], w: ['Verificar antes del informe', '#5b3f8a', '#efe8f8'] };

function incHabiles_(a, b) {
  if (!a || !b || b <= a) return 0;
  var d = new Date(a + 'T12:00:00'), e = new Date(b + 'T12:00:00'), n = 0;
  while (d < e) { d.setDate(d.getDate() + 1); var w = d.getDay(); if (w > 0 && w < 6) n++; }
  return n;
}

/* Expedientes abiertos con su etapa y semáforo: mismo cálculo que el tablero. */
function incExpedientes_() {
  var D = JSON.parse(UrlFetchApp.fetch(INC_LIBRO_FUENTE + '?_=' + Date.now()).getContentText()), ix = {};
  D.cols.forEach(function (k, i) { ix[k] = i; });
  var hoy = incFmt_(new Date()), ev = {};
  incLeerEventos_('').forEach(function (e) { if (e.estado !== 'ANULADO') (ev[e.exp] = ev[e.exp] || []).push(e); });
  var sc = {};
  try {
    var S = JSON.parse(UrlFetchApp.fetch(INC_SISCOMP + '?_=' + Date.now(), { muteHttpExceptions: true }).getContentText());
    (S.confirmados || []).forEach(function (r) { r.exp.forEach(function (id) { sc[id] = r.ped; }); });
  } catch (e) { sc = null; }
  var an = {};
  try { an = JSON.parse(UrlFetchApp.fetch(INC_ANTECED + '?_=' + Date.now(), { muteHttpExceptions: true }).getContentText()).exp || {}; } catch (e) { an = {}; }
  var out = [];
  D.rows.forEach(function (x) {
    var venc = String(x[ix.venc] || ''), saldo = Number(x[ix.saldo] || 0);
    if (!venc || venc >= hoy || saldo <= 0) return;
    var id = 'EXP-' + x[ix.req] + '-' + String(x[ix.nota]).replace(/[^0-9A-Za-z.]/g, '');
    var nota = { venc: venc, et: Math.min(5, Number(x[ix.et] || 0)), fAviso: String(x[ix.fAviso] || ''), fNotP: String(x[ix.fNotP] || '') };
    var st = incEstado_(nota, ev[id] || []);
    if (st.act > 7) return;
    var p = INC_PLAZOS[st.act], d = incHabiles_(st.ini, hoy);
    var se = p === null ? 'g' : (d < 0.8 * p ? 'v' : (d <= p ? 'a' : 'r'));
    var ver = an[id] || null;
    if (st.act === 2 && ver && ver.c !== 'PASA') se = 'w';
    out.push({ id: id, req: String(x[ix.req]), cod: String(x[ix.cod] || ''), desc: String(x[ix.desc] || ''), prov: String(x[ix.prov] || ''),
      venc: venc, val: saldo * Number(x[ix.precio] || 0), act: st.act, d: d, p: p, se: se,
      sc: sc === null ? '' : (sc[id] ? 'Confirmado por SisCOMP' : '—'), verM: (ver && ver.c !== 'PASA') ? ver.m : '' });
  });
  var ord = { r: 0, a: 1, w: 2, g: 3, v: 4 };
  out.sort(function (a, b) { return (ord[a.se] - ord[b.se]) || (b.val - a.val); });
  return { corte: D.corte, hoy: hoy, X: out, siscomp: sc !== null };
}

/* Destinatarios por cargo (y supervisores) desde INC_USUARIOS. */
function incDestinatarios_() {
  var v = incHoja_(INC_HOJA_USUARIOS, INC_COLS_USUARIOS).getDataRange().getValues(), c = incIdx_(v[0]);
  var porCargo = {}, resumen = [], porDir = {};
  for (var i = 1; i < v.length; i++) {
    var r = v[i], correo = String(r[c.CORREO] || '').trim();
    if (String(r[c.ACTIVO] || 'SI').toUpperCase() === 'NO' || String(r[c.NOTA] || '').toUpperCase() === 'PRUEBA' || !/@/.test(correo)) continue;
    var rol = String(r[c.ROL] || 'OPERADOR').toUpperCase(), cargo = incNorm_(r[c.CARGO]);
    if (rol === 'SUPERVISOR' || rol === 'CONSULTA') { resumen.push(correo); var dr = incNorm_(r[c.DIRECCION]); (porDir[dr] = porDir[dr] || []).push(correo); }
    else (porCargo[cargo] = porCargo[cargo] || []).push(correo);
  }
  return { porCargo: porCargo, resumen: resumen, porDir: porDir };
}

function incFm_(n) { return 'B/. ' + (n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : Math.round(n).toLocaleString('en-US')); }
function incEsc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

function incHtml_(titulo, intro, L, conEtapa, pie, aviso) {
  var n = function (s) { return L.filter(function (o) { return o.se === s; }).length; };
  var pill = function (s, v) { return '<td style="padding:10px 14px;background:' + INC_SEM[s][2] + ';border-radius:8px"><div style="font-size:11px;color:' + INC_SEM[s][1] + '">' + INC_SEM[s][0] + '</div><div style="font-size:22px;font-weight:700;color:' + INC_SEM[s][1] + '">' + v + '</div></td><td width="8"></td>'; };
  var filas = L.slice(0, 25).map(function (o) {
    var s = INC_SEM[o.se];
    return '<tr><td style="padding:6px;border-bottom:1px solid #e5e7eb"><a href="' + INC_TABLERO + '?v=fic&exp=' + encodeURIComponent(o.id) + '" style="color:#1e5a9e;font-family:monospace">' + o.id + '</a></td>' +
      '<td style="padding:6px;border-bottom:1px solid #e5e7eb">' + incEsc_(o.prov) + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #e5e7eb">' + incEsc_(o.cod) + ' · ' + incEsc_(o.desc.slice(0, 60)) + (o.verM ? '<div style="color:#5b3f8a;font-size:11px;margin-top:2px">' + incEsc_(o.verM) + '</div>' : '') + '</td>' +
      (conEtapa ? '<td style="padding:6px;border-bottom:1px solid #e5e7eb">' + o.act + ' · ' + INC_ETAPAS[o.act - 1][3] + '</td>' : '') +
      '<td style="padding:6px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap">' + incFm_(o.val) + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #e5e7eb;text-align:right">' + o.d + (o.p ? ' de ' + o.p : '') + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #e5e7eb"><span style="background:' + s[2] + ';color:' + s[1] + ';padding:2px 8px;border-radius:10px;font-size:11px;white-space:nowrap">' + s[0] + '</span></td>' +
      (o.sc ? '<td style="padding:6px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#555">' + o.sc + '</td>' : '') + '</tr>';
  }).join('');
  var th = function (t) { return '<th style="padding:6px;text-align:left;background:#1e5a9e;color:#fff;font-weight:600">' + t + '</th>'; };
  return '<div style="font-family:Arial,sans-serif;font-size:13px;color:#1f2937;max-width:900px">' +
    (aviso ? '<div style="background:#fff4d6;border:1px solid #f2dc7a;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px">' + aviso + '</div>' : '') +
    incCabecera_(titulo, 18) +
    '<div style="padding:14px 18px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">' +
    '<p style="margin:0 0 12px">' + intro + '</p>' +
    '<table cellspacing="0" cellpadding="0"><tr>' + pill('r', n('r')) + pill('a', n('a')) + (n('w') ? pill('w', n('w')) : '') + pill('v', n('v')) + (n('g') ? pill('g', n('g')) : '') + '</tr></table>' +
    (L.length ? '<p style="margin:14px 0 6px;font-weight:700">Qué hacer hoy' + (L.length > 25 ? ' (los 25 más urgentes de ' + L.length + ')' : '') + '</p>' +
      '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:12px"><tr>' + th('Expediente') + th('Proveedor') + th('Renglón') + (conEtapa ? th('Espera la etapa') : '') + th('Saldo') + th('Días hábiles') + th('Semáforo') + (L[0].sc ? th('SisCOMP') : '') + '</tr>' + filas + '</table>' : '<p>No hay expedientes esperando esta etapa.</p>') +
    '<p style="margin:14px 0 0"><a href="' + INC_TABLERO + '?v=exp" style="background:#1e5a9e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Abrir el tablero</a></p>' +
    '<p style="font-size:11px;color:#6b7280;margin-top:14px">' + pie + '</p></div></div>';
}

function incCabecera_(titulo, tam) {
  return '<table cellspacing="0" cellpadding="0" width="100%" style="background:#0c447c;border-radius:8px 8px 0 0"><tr>' +
    '<td width="64" style="padding:12px 0 12px 16px"><img src="' + INC_LOGO + '" width="48" height="48" alt="CSS" style="display:block;border:0;background:#fff;border-radius:50%"></td>' +
    '<td style="padding:12px 16px;color:#fff;font-family:Arial,sans-serif"><div style="font-size:11px;opacity:.85">CAJA DE SEGURO SOCIAL · DIRECCIÓN NACIONAL DE LOGÍSTICA</div>' +
    '<div style="font-size:11px;opacity:.85">EXPEDIENTE DE INCUMPLIMIENTO DE ENTREGA</div><div style="font-size:' + tam + 'px;font-weight:700;margin-top:2px">' + titulo + '</div></td></tr></table>';
}

function incEnviar_(o) {
  if (typeof correoEnviar_ === 'function') correoEnviar_(o); else MailApp.sendEmail(o);
}

function incCorreoDiario(forzar) {
  var demo = forzar === 'DEMO';
  forzar = (forzar === 'PRUEBA' || demo) ? 'PRUEBA' : null; // el disparador pasa un objeto de evento
  var props = PropertiesService.getScriptProperties();
  var modo = String(props.getProperty('INC_CORREO_MODO') || 'PRUEBA').toUpperCase();
  if (modo === 'APAGADO' && !forzar) return 'apagado';
  var w = Number(Utilities.formatDate(new Date(), 'America/Panama', 'u'));
  if (w > 5 && !forzar) return 'fin de semana';
  var prueba = forzar === 'PRUEBA' || modo !== 'REAL';
  var destPrueba = props.getProperty('INC_CORREO_PRUEBA') || Session.getEffectiveUser().getEmail();
  var E = incExpedientes_(), dest = incDestinatarios_(), enviados = 0;
  var fd = function (s) { return s ? s.split('-').reverse().join('/') : ''; };
  var pie = 'Fuente: libro de Incumplimientos de Seguimiento al ' + fd(E.corte) + (E.siscomp ? ' y extracto de SisCOMP de la Dirección Nacional de Compras' : '') +
    '. Días hábiles de lunes a viernes desde el último hito; plazos propuestos por DINALOG. Cada responsable registra su etapa en la ficha con su PIN y adjunta el documento firmado (Ley 419, arts. 228 a 233). Correo automático de la Torre de Control · DINALOG.';
  var mandar = function (para, asunto, html, cargoTxt) {
    if (prueba) {
      var av = '<b>PRUEBA.</b> En uso real este correo iría a: ' + (para.length ? incEsc_(para.join(', ')) : (cargoTxt === 'Resumen para directores' ? '<i>nadie todavía — falta cargar en INC_USUARIOS a los directores (ROL SUPERVISOR o CONSULTA) con su correo</i>' : '<i>nadie todavía — falta cargar en INC_USUARIOS a la persona titular o suplente de «' + incEsc_(cargoTxt) + '» con su correo</i>')) + '.';
      incEnviar_({ to: destPrueba, subject: '[PRUEBA · ' + cargoTxt + '] ' + asunto, htmlBody: html.replace('<div style="font-family:Arial', '<div style="background:#fff4d6;border:1px solid #f2dc7a;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-family:Arial;font-size:12px">' + av + '</div><div style="font-family:Arial'), name: 'Torre de Control CSS' });
      enviados++; return;
    }
    if (!para.length) return;
    incEnviar_({ to: para.join(','), subject: asunto, htmlBody: html, name: 'Torre de Control CSS' }); enviados++;
  };
  // 1) Un correo por cargo con las etapas que le tocan
  var cargos = {};
  INC_ETAPAS.forEach(function (e) { if (e[0] > 1) (cargos[e[1]] = cargos[e[1]] || []).push(e[0]); });
  Object.keys(cargos).forEach(function (cargo) {
    var L = E.X.filter(function (o) { return cargos[cargo].indexOf(o.act) >= 0; });
    if (!L.length && !prueba) return;
    var rojos = L.filter(function (o) { return o.se === 'r'; }).length;
    var et = cargos[cargo].map(function (n) { return n + ' · ' + INC_ETAPAS[n - 1][3]; }).join('; ');
    var intro = 'Buenos días. Estos expedientes esperan su registro en: <b>' + incEsc_(et) + '</b>. ' +
      (rojos ? '<b style="color:#c83a3a">' + rojos + ' ya pasaron el plazo de la etapa.</b> ' : '') + 'Al registrar el hito con su PIN, el expediente pasa a la siguiente dirección y deja de aparecer aquí.';
    mandar(dest.porCargo[incNorm_(cargo)] || [], 'Expedientes de incumplimiento · ' + L.length + ' por registrar' + (rojos ? ' · ' + rojos + ' vencidos' : '') + ' · ' + fd(E.hoy),
      incHtml_(cargo, intro, L, cargos[cargo].length > 1, pie), cargo);
  });
  // 2) Resumen para supervisores y consulta (las tres direcciones)
  var porEt = INC_ETAPAS.slice(1).map(function (e) {
    var L = E.X.filter(function (o) { return o.act === e[0]; }), r = L.filter(function (o) { return o.se === 'r'; }).length;
    return '<tr><td style="padding:4px 8px">' + e[0] + ' · ' + e[3] + '</td><td style="padding:4px 8px">' + incEsc_(e[1]) + '</td><td style="padding:4px 8px;text-align:right">' + L.length + '</td><td style="padding:4px 8px;text-align:right;color:#c83a3a">' + r + '</td></tr>';
  }).join('');
  var sv = E.X.reduce(function (a, o) { return a + o.val; }, 0);
  var introR = 'Buenos días. Hay <b>' + E.X.length + '</b> expedientes abiertos por <b>' + incFm_(sv) + '</b> de saldo vencido.' +
    '<table cellspacing="0" style="margin:10px 0;font-size:12px;border-collapse:collapse"><tr style="background:#eef1f4"><th style="padding:4px 8px;text-align:left">Etapa</th><th style="padding:4px 8px;text-align:left">Le toca a</th><th style="padding:4px 8px">Expedientes</th><th style="padding:4px 8px">Vencidos</th></tr>' + porEt + '</table>';
  mandar(dest.resumen, 'Expedientes de incumplimiento · resumen · ' + E.X.length + ' abiertos · ' + fd(E.hoy), incHtml_('Resumen de las tres direcciones', introR, E.X, true, pie), 'Resumen para directores');
  // 3) Escalamiento: expedientes que hoy pasaron el plazo de su etapa, al director de la dirección que debe actuar
  var hoyRojo = E.X.filter(function (o) { return o.se === 'r' && o.p && o.d === o.p + 1; }), porD = {};
  if (demo && !hoyRojo.length) hoyRojo = E.X.filter(function (o) { return o.se === 'r'; }).slice(0, 2);  // muestra del escalamiento
  hoyRojo.forEach(function (o) { var dr = INC_ETAPAS[o.act - 1][2]; (porD[dr] = porD[dr] || []).push(o); });
  Object.keys(porD).forEach(function (dr) {
    var L = porD[dr];
    var intro = 'Buenos días. <b>' + L.length + '</b> expediente' + (L.length > 1 ? 's' : '') + ' de la ' + incEsc_(dr) + ' <b style="color:#c83a3a">' + (L.length > 1 ? 'pasaron' : 'pasó') + ' hoy el plazo de su etapa</b> sin registro. El responsable ya lo tenía en su correo diario; se avisa a la dirección para que dé seguimiento.';
    mandar(dest.porDir[incNorm_(dr)] || [], 'Plazo vencido hoy · ' + L.length + ' expediente' + (L.length > 1 ? 's' : '') + ' · ' + dr + ' · ' + fd(E.hoy),
      incHtml_('Escalamiento · ' + dr, intro, L, true, pie), 'Escalamiento · ' + dr);
  });
  Logger.log('Correo diario (' + (prueba ? 'PRUEBA → ' + destPrueba : 'REAL') + '): ' + enviados + ' correos · ' + E.X.length + ' expedientes · ' + hoyRojo.length + ' escalados.');
  return enviados;
}

/* Aviso inmediato: al registrar una etapa, el cargo que sigue recibe el expediente en ese momento. */
function incSumarHabiles_(f, n) {
  var d = new Date(f + 'T12:00:00');
  while (n > 0) { d.setDate(d.getDate() + 1); var w = d.getDay(); if (w > 0 && w < 6) n--; }
  return incFmt_(d);
}

function incAvisoEtapa_(exp, nota, etapa, fecha, u, forzarPrueba) {
  var props = PropertiesService.getScriptProperties();
  var modo = String(props.getProperty('INC_CORREO_MODO') || 'PRUEBA').toUpperCase();
  if (modo === 'APAGADO' && !forzarPrueba) return 'apagado';
  var prueba = forzarPrueba || modo !== 'REAL', destPrueba = props.getProperty('INC_CORREO_PRUEBA') || Session.getEffectiveUser().getEmail();
  var dest = incDestinatarios_(), fd = function (s) { return s ? s.split('-').reverse().join('/') : ''; };
  var sig = etapa + 1, para, asunto, cargoTxt, cuerpo;
  var link = INC_TABLERO + '?v=fic&exp=' + encodeURIComponent(exp);
  var dato = '<table cellspacing="0" style="font-size:13px;border-collapse:collapse;margin:8px 0">' +
    [['Proveedor', nota.prov], ['Orden de compra · nota', nota.req + ' · ' + nota.nota], ['Renglón', nota.cod], ['Venció la nota', fd(nota.venc)],
     ['Etapa registrada', etapa + ' · ' + INC_ETAPAS[etapa - 1][3]], ['Registró', u.nombre + ' · ' + u.cargo + ', el ' + fd(fecha) + ', con su documento']]
      .map(function (r) { return '<tr><td style="padding:3px 12px 3px 0;color:#6b7280">' + r[0] + '</td><td style="padding:3px 0"><b>' + incEsc_(r[1]) + '</b></td></tr>'; }).join('') + '</table>';
  if (sig > 7) {
    para = dest.resumen; cargoTxt = 'Cierre del expediente';
    asunto = 'Expediente cerrado · ' + exp + ' · ' + nota.prov;
    cuerpo = '<p>El expediente <b>' + exp + '</b> completó sus siete etapas: la resolución se notificó y la fianza está en ejecución.</p>' + dato;
  } else {
    var e = INC_ETAPAS[sig - 1], plazo = INC_PLAZOS[sig], hasta = plazo ? incSumarHabiles_(fecha, plazo) : '';
    para = dest.porCargo[incNorm_(e[1])] || []; cargoTxt = e[1];
    asunto = 'Le toca: ' + exp + ' · etapa ' + sig + ' · ' + e[3] + (hasta ? ' · plazo ' + fd(hasta) : '');
    cuerpo = '<p style="font-size:15px">El expediente <b>' + exp + '</b> pasó a su etapa: <b>' + sig + ' · ' + incEsc_(e[3]) + '</b>.</p>' +
      '<p>' + (plazo ? 'Su plazo: <b>' + plazo + ' días hábiles, hasta el ' + fd(hasta) + '</b>.' : 'Esta etapa todavía no tiene plazo acordado.') + ' Al registrar, adjunte el documento firmado.</p>' + dato;
  }
  var html = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#1f2937;max-width:720px">' +
    incCabecera_(incEsc_(cargoTxt), 17) +
    '<div style="padding:12px 16px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">' + cuerpo +
    '<p style="margin:14px 0 0"><a href="' + link + '" style="background:#1e5a9e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Abrir la ficha</a></p>' +
    '<p style="font-size:11px;color:#6b7280;margin-top:14px">Aviso automático de la Torre de Control · DINALOG. Ley 419, arts. 228 a 233.</p></div></div>';
  var cc = sig > 7 ? [] : dest.resumen;
  if (prueba) {
    var av = '<div style="background:#fff4d6;border:1px solid #f2dc7a;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-family:Arial;font-size:12px"><b>PRUEBA.</b> En uso real iría a: ' +
      (para.length ? incEsc_(para.join(', ')) : '<i>nadie todavía — falta cargar en INC_USUARIOS al titular o suplente de «' + incEsc_(cargoTxt) + '»</i>') + (cc.length ? ' · con copia a ' + incEsc_(cc.join(', ')) : '') + '.</div>';
    incEnviar_({ to: destPrueba, subject: '[PRUEBA · ' + cargoTxt + '] ' + asunto, htmlBody: av + html, name: 'Torre de Control CSS' });
    return 'prueba';
  }
  if (!para.length && !cc.length) return 'sin destinatarios';
  var o = { to: (para.length ? para : cc).join(','), subject: asunto, htmlBody: html, name: 'Torre de Control CSS' };
  if (para.length && cc.length) o.cc = cc.join(',');
  incEnviar_(o);
  return 'enviado';
}

function incCorreoVistaPrevia() { return incCorreoDiario('PRUEBA'); }

/* Muestra completa a INC_CORREO_PRUEBA (o a la cuenta del script): aviso inmediato, correos diarios,
   resumen y una muestra del escalamiento. No registra nada ni escribe a nadie más. */
function incCorreoPruebaCompleta() {
  var E = incExpedientes_(), o = E.X.filter(function (x) { return x.act === 2; })[0];
  if (o) {
    var nota = incNotaDelLibro_(o.id);
    if (!nota.error) Logger.log('aviso: ' + incAvisoEtapa_(o.id, nota, 2, incFmt_(new Date()), { nombre: '(muestra) Jefe del Departamento de Seguimiento', cargo: 'Jefe del Departamento de Seguimiento' }, true));
  }
  return incCorreoDiario('DEMO');
}

function incCorreoInstalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'incCorreoDiario') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('incCorreoDiario').timeBased().everyDays(1).atHour(7).inTimezone('America/Panama').create();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('INC_CORREO_MODO')) props.setProperty('INC_CORREO_MODO', 'PRUEBA');
  Logger.log('Disparador diario 7:00 (Panamá) creado. Modo: ' + props.getProperty('INC_CORREO_MODO') + '. Para enviar a los responsables: INC_CORREO_MODO = REAL.');
}

/* ==================================================================== */
/*  INFORME EJECUTIVO SEMANAL · DENA (y versión para el Director General)*/
/*  Los PDF los arma GitHub (scripts/informe_ejecutivo.py) con los mismos */
/*  datos del tablero; aquí solo se bajan y se envían.                  */
/*  Propiedades: INC_INFORME_MODO = PRUEBA (por defecto) | REAL | APAGADO*/
/*               INC_INFORME_DEST = correo(s) de la DENA, separados por , */
/*               INC_INFORME_CC   = copia opcional (Dirección de Logística)*/
/*  Instalar: incInformeInstalar() · Probar: incInformePrueba()          */
/* ==================================================================== */

var INC_INFORME_URL = 'https://torrecontrolcss.org/seguire/informes/';

function incInformeEjecutivo(forzar) {
  forzar = forzar === 'PRUEBA' ? 'PRUEBA' : null;
  var props = PropertiesService.getScriptProperties();
  var modo = String(props.getProperty('INC_INFORME_MODO') || 'PRUEBA').toUpperCase();
  if (modo === 'APAGADO' && !forzar) return 'apagado';
  var prueba = forzar === 'PRUEBA' || modo !== 'REAL';
  var t = '?_=' + Date.now(), bajar = function (f) {
    var r = UrlFetchApp.fetch(INC_INFORME_URL + f + t, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('No se pudo bajar ' + f + ' (' + r.getResponseCode() + ')');
    return r;
  };
  var R = JSON.parse(bajar('incumplimiento_ejecutivo.json').getContentText());
  var fd = function (s) { return s ? s.split('-').reverse().join('/') : ''; };
  var pdf1 = bajar('incumplimiento_ejecutivo.pdf').getBlob().setName('Informe_ejecutivo_incumplimiento_' + R.hoy + '.pdf');
  var pdf2 = bajar('incumplimiento_ejecutivo_DG.pdf').getBlob().setName('Resumen_Director_General_incumplimiento_' + R.hoy + '.pdf');
  var dest = String(props.getProperty('INC_INFORME_DEST') || '').trim(), cc = String(props.getProperty('INC_INFORME_CC') || '').trim();
  var k = function (n, l, f, c) { return '<td style="padding:10px 14px;background:' + f + ';border-radius:8px"><div style="font-size:20px;font-weight:700;color:' + c + '">' + n + '</div><div style="font-size:11px;color:#374151">' + l + '</div></td><td width="8"></td>'; };
  var html = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#1f2937;max-width:760px">' + incCabecera_('Informe ejecutivo semanal', 18) +
    '<div style="padding:14px 18px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">' +
    '<p style="margin:0 0 12px">Buenos días. Le hacemos llegar el informe ejecutivo del expediente de incumplimiento de entrega al ' + fd(R.hoy) + ', con el libro de Seguimiento al ' + fd(R.corteLibro) + '.</p>' +
    '<table cellspacing="0" cellpadding="0"><tr>' + k(R.expedientes, 'expedientes abiertos', '#eef4fb', '#0c447c') + k(incFm_(R.saldo), 'saldo no entregado', '#eef4fb', '#0c447c') +
    k((R.semaforo.r || 0), 'vencidos en su etapa', '#fbe3e3', '#c83a3a') + k(R.verificacion.n, 'en verificación previa', '#efe8f8', '#5b3f8a') + '</tr></table>' +
    '<p style="margin:14px 0 6px"><b>' + Math.round(R.top5pct) + ' % del saldo está en 5 proveedores.</b> ' + (R.etapas['2'] || 0) + ' expedientes esperan aún el informe de incumplimiento (etapa 2).</p>' +
    '<p style="margin:6px 0">Se adjuntan dos documentos:</p><ul style="margin:0 0 10px;padding-left:20px">' +
    '<li><b>Informe ejecutivo</b> (3 páginas): situación, proveedores y renglones con más saldo, y las decisiones que se necesitan.</li>' +
    '<li><b>Resumen para el Director General</b> (1 página), para elevarlo si lo estima conveniente.</li></ul>' +
    '<p style="margin:14px 0 0"><a href="' + INC_TABLERO + '" style="background:#1e5a9e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Ver el tablero en línea</a></p>' +
    '<p style="font-size:11px;color:#6b7280;margin-top:14px">Informe generado automáticamente cada semana por la Torre de Control · Dirección Nacional de Logística, con el libro de Seguimiento, el cruce cierto con SisCOMP+ y los registros de SIGUELO.</p></div></div>';
  var asunto = 'Expediente de incumplimiento · informe ejecutivo · ' + R.expedientes + ' abiertos · ' + incFm_(R.saldo) + ' · ' + fd(R.hoy);
  if (prueba) {
    var yo = props.getProperty('INC_CORREO_PRUEBA') || Session.getEffectiveUser().getEmail();
    var av = '<div style="background:#fff4d6;border:1px solid #f2dc7a;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-family:Arial;font-size:12px"><b>PRUEBA.</b> En uso real este correo iría a: ' +
      (dest ? incEsc_(dest) + (cc ? ' · copia: ' + incEsc_(cc) : '') : '<i>falta poner el correo de la DENA en la propiedad INC_INFORME_DEST</i>') + '.</div>';
    incEnviar_({ to: yo, subject: '[PRUEBA · DENA] ' + asunto, htmlBody: av + html, attachments: [pdf1, pdf2], name: 'Torre de Control CSS' });
    Logger.log('Informe ejecutivo (PRUEBA → ' + yo + ')'); return 'prueba';
  }
  if (!dest) { Logger.log('Falta INC_INFORME_DEST'); return 'sin destinatario'; }
  var o = { to: dest, subject: asunto, htmlBody: html, attachments: [pdf1, pdf2], name: 'Torre de Control CSS' };
  if (cc) o.cc = cc;
  incEnviar_(o); Logger.log('Informe ejecutivo enviado a ' + dest); return 'enviado';
}

function incInformePrueba() { return incInformeEjecutivo('PRUEBA'); }

function incInformeInstalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'incInformeEjecutivo') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('incInformeEjecutivo').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone('America/Panama').create();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('INC_INFORME_MODO')) props.setProperty('INC_INFORME_MODO', 'PRUEBA');
  Logger.log('Disparador semanal: lunes 8:00 (Panamá). Modo: ' + props.getProperty('INC_INFORME_MODO') + '. Para enviarlo a la DENA: INC_INFORME_DEST = su correo e INC_INFORME_MODO = REAL.');
}

/* ==================================================================== */
/*  CARGA INICIAL (empate) · una sola vez, antes de la fecha de arranque */
/*  1) Cada jefe devuelve el Excel de empate (scripts/empate_excel.py).  */
/*  2) En el libro del expediente se crea una pestaña CARGA_<cargo> por  */
/*     hoja recibida y se pega desde la fila de códigos (EXPEDIENTE,     */
/*     E2_HECHO, E2_FECHA, E2_DOC, E2_PDF...) hacia abajo.               */
/*  3) incCargaInicialSimular(): revisa todo y escribe CARGA_REPORTE,    */
/*     sin registrar nada.                                               */
/*  4) incCargaInicialAplicar(): registra los hitos válidos como         */
/*     «Carga inicial», sin correos de aviso; se puede repetir sin       */
/*     duplicar.                                                         */
/* ==================================================================== */

function incCargaInicialSimular() { return incCargaInicial_(false); }
function incCargaInicialAplicar() { return incCargaInicial_(true); }

function incCargaInicial_(aplicar) {
  var ss = incLibro_(), hojas = ss.getSheets().filter(function (h) { return /^CARGA_/i.test(h.getName()) && h.getName() !== 'CARGA_REPORTE'; });
  if (!hojas.length) { Logger.log('No hay pestañas CARGA_<cargo> en ' + ss.getUrl()); return 'sin hojas'; }
  var D = JSON.parse(UrlFetchApp.fetch(INC_LIBRO_FUENTE + '?_=' + Date.now()).getContentText()), ix = {}, libro = {};
  D.cols.forEach(function (k, i) { ix[k] = i; });
  D.rows.forEach(function (x) {
    var id = 'EXP-' + x[ix.req] + '-' + String(x[ix.nota]).replace(/[^0-9A-Za-z.]/g, '');
    libro[id] = { req: String(x[ix.req]), nota: String(x[ix.nota]), cod: String(x[ix.cod] || ''), prov: String(x[ix.prov] || ''),
      venc: String(x[ix.venc] || ''), et: Math.min(5, Number(x[ix.et] || 0)), fAviso: String(x[ix.fAviso] || ''), fNotP: String(x[ix.fNotP] || '') };
  });
  var hoy = incFmt_(new Date());
  var aFecha = function (v) {
    if (v instanceof Date) return incFmt_(v);
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[0] : '';
  };
  // Declaraciones: { exp: { etapa: {fecha, doc, pdf, hoja, fila} } }
  var dec = {}, rep = [];
  hojas.forEach(function (h) {
    var v = h.getDataRange().getValues(), f0 = -1;
    for (var i = 0; i < Math.min(10, v.length); i++) if (String(v[i][0]).trim() === 'EXPEDIENTE') { f0 = i; break; }
    if (f0 < 0) { rep.push([h.getName(), '', '', '', 'ERROR', 'No encontré la fila de códigos (EXPEDIENTE, E2_HECHO…).']); return; }
    var c = {}; v[f0].forEach(function (k, j) { c[String(k).trim()] = j; });
    for (var r = f0 + 1; r < v.length; r++) {
      var exp = String(v[r][0] || '').trim(); if (!exp) continue;
      for (var e = 2; e <= 7; e++) {
        if (c['E' + e + '_HECHO'] == null) continue;
        var he = String(v[r][c['E' + e + '_HECHO']] || '').trim().toUpperCase();
        if (he !== 'SÍ' && he !== 'SI') continue;
        (dec[exp] = dec[exp] || {})[e] = { fecha: aFecha(v[r][c['E' + e + '_FECHA']]), doc: String(v[r][c['E' + e + '_DOC']] || '').trim(),
          pdf: String(v[r][c['E' + e + '_PDF']] || '').trim(), hoja: h.getName(), fila: r + 1 };
      }
    }
  });
  var lock = LockService.getScriptLock();
  if (aplicar && !lock.tryLock(30000)) return 'ocupado';
  var sh = incHoja_(INC_HOJA_EVENTOS, INC_COLS_EVENTOS), todos = incLeerEventos_(''), porExp = {}, nuevos = 0;
  todos.forEach(function (x) { (porExp[x.exp] = porExp[x.exp] || []).push(x); });
  try {
    Object.keys(dec).sort().forEach(function (exp) {
      var nota = libro[exp], et = Object.keys(dec[exp]).map(Number).sort();
      if (!nota) { et.forEach(function (e) { var d = dec[exp][e]; rep.push([d.hoja, d.fila, exp, e, 'ERROR', 'El expediente no está en el libro de Seguimiento publicado.']); }); return; }
      var ev = (porExp[exp] || []).slice();
      et.forEach(function (e) {
        var d = dec[exp][e], st = incEstado_(nota, ev), idc = 'CARGA-' + exp + '-E' + e;
        var r = function (est, msg) { rep.push([d.hoja, d.fila, exp, e, est, msg]); };
        if (ev.some(function (x) { return x.idCliente === idc && x.estado !== 'ANULADO'; })) return r('YA CARGADO', 'Este hito ya se había cargado.');
        if (e < st.act) return r('YA CONSTA', 'La etapa ya constaba; no se registra de nuevo.');
        if (e > st.act) return r('ERROR', 'Falta declarar antes la etapa ' + st.act + ' (' + INC_ETAPAS[st.act - 1][3] + ').');
        if (!d.fecha) return r('ERROR', 'Falta la fecha o no es válida (dd/mm/aaaa).');
        if (d.fecha > hoy) return r('ERROR', 'La fecha es futura.');
        if (st.ini && d.fecha < st.ini) return r('ERROR', 'La fecha es anterior al hito previo (' + st.ini + ').');
        if (!d.doc) return r('ERROR', 'Falta el número del documento.');
        if (!d.pdf) return r('ERROR', 'Falta el PDF firmado (enlace o nombre del archivo).');
        ev.push({ exp: exp, etapa: e, fecha: d.fecha, estado: 'VIGENTE', idCliente: idc });
        if (aplicar) {
          var fila = { TS_SERVIDOR: new Date(), ID_EVENTO: 'INC-CI-' + Utilities.formatDate(new Date(), 'America/Panama', 'yyyyMMddHHmmss') + '-' + (nuevos + 1),
            ID_CLIENTE: idc, EXPEDIENTE: exp, OC: nota.req, NOTA: nota.nota, RENGLON: nota.cod, PROVEEDOR: nota.prov, ETAPA: e, FECHA_HITO: d.fecha,
            USUARIO: 'Carga inicial · ' + INC_ETAPAS[e - 1][1], CARGO: INC_ETAPAS[e - 1][1], DIRECCION: INC_ETAPAS[e - 1][2],
            OBSERVACION: 'CARGA INICIAL (empate) · documento ' + d.doc + ' · declarado en ' + d.hoja + ', fila ' + d.fila,
            EVIDENCIA_URL: /^https?:\/\//.test(d.pdf) ? d.pdf : '', EVIDENCIA_NOMBRE: /^https?:\/\//.test(d.pdf) ? d.doc : d.pdf, ESTADO: 'VIGENTE' };
          sh.appendRow(INC_COLS_EVENTOS.map(function (k) { var x = fila[k]; return x == null ? '' : x; }));
          sh.getRange(sh.getLastRow(), INC_COLS_EVENTOS.indexOf('FECHA_HITO') + 1).setNumberFormat('@').setValue(d.fecha);
          nuevos++;
        }
        r(aplicar ? 'REGISTRADO' : 'VÁLIDO', 'Etapa ' + e + ' · ' + d.fecha + ' · ' + d.doc);
      });
    });
    if (aplicar && nuevos) { SpreadsheetApp.flush(); try { incPublicar_(true); } catch (eP) { Logger.log('incPublicar_: ' + eP); } }
  } finally { if (aplicar) lock.releaseLock(); }
  var hr = ss.getSheetByName('CARGA_REPORTE') || ss.insertSheet('CARGA_REPORTE');
  hr.clear(); hr.getRange(1, 1, 1, 6).setValues([['HOJA', 'FILA', 'EXPEDIENTE', 'ETAPA', 'RESULTADO', 'DETALLE']]).setFontWeight('bold');
  if (rep.length) hr.getRange(2, 1, rep.length, 6).setValues(rep);
  var cuenta = {}; rep.forEach(function (x) { cuenta[x[4]] = (cuenta[x[4]] || 0) + 1; });
  Logger.log((aplicar ? 'CARGA APLICADA' : 'SIMULACIÓN') + ': ' + JSON.stringify(cuenta) + (aplicar ? ' · ' + nuevos + ' hitos nuevos' : '') + '. Detalle en CARGA_REPORTE.');
  return cuenta;
}
