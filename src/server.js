'use strict';

const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Configuracion (todo llega por variables de entorno; nada se guarda en la imagen)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || 'sin-instancia';

// Solo para la prueba de timeout. Con ENABLE_TEST_DELAY distinto de "true" (valor por
// defecto) la cabecera X-Test-Delay-Ms se ignora y el servicio nunca demora a proposito.
const ENABLE_TEST_DELAY = process.env.ENABLE_TEST_DELAY === 'true';
const MAX_TEST_DELAY_MS = 30000;

// Rutas que no se anotan en la tabla intentos: el healthcheck de Docker (ruido cada 10 s)
// y la propia consulta de la bitacora.
const RUTAS_SIN_BITACORA = new Set(['/live', '/intentos']);

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_DESTINATARIO = 200;
const MAX_DIRECCION = 300;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 10,
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
});

// Un error en una conexion inactiva del pool no debe tumbar el proceso.
pool.on('error', (err) => console.error(`[${INSTANCE_ID}] error en conexion inactiva del pool: ${err.message}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

// ---------------------------------------------------------------------------
// Bitacora de intentos
// Cada solicitud deja una fila en la tabla intentos. Los manejadores completan
// res.locals.intento; la fila se escribe una sola vez: o bien de forma explicita
// (antes de la espera simulada) o bien al cerrarse la respuesta.
// ---------------------------------------------------------------------------
function resultadoPorDefecto(httpStatus) {
  if (httpStatus === null) return 'CLIENTE_ABORTO';
  if (httpStatus < 300) return 'OK';
  if (httpStatus === 404) return 'RUTA_NO_ENCONTRADA';
  if (httpStatus < 500) return 'RECHAZADO';
  return 'ERROR_INTERNO';
}

async function registrarIntento(req, res) {
  const intento = res.locals.intento;
  if (!intento || intento.registrado) return;
  intento.registrado = true;

  const httpStatus = intento.httpStatus ?? (res.headersSent ? res.statusCode : null);
  const resultado = intento.resultado ?? resultadoPorDefecto(httpStatus);

  try {
    await pool.query(
      `INSERT INTO intentos
         (request_id, metodo, ruta, instancia, ip_cliente, idempotency_key, resultado, envio_id, http_status, detalle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        req.get('x-request-id') || null,
        req.method,
        req.path,
        INSTANCE_ID,
        req.get('x-real-ip') || req.socket.remoteAddress || null,
        intento.idempotencyKey,
        resultado,
        intento.envioId,
        httpStatus,
        intento.detalle,
      ]
    );
  } catch (err) {
    // La bitacora nunca debe romper la solicitud; el fallo queda en el log del contenedor.
    console.error(`[${INSTANCE_ID}] no se pudo registrar el intento: ${err.message}`);
  }
}

function bitacora(req, res, next) {
  if (RUTAS_SIN_BITACORA.has(req.path)) return next();
  res.locals.intento = {
    resultado: null,
    envioId: null,
    idempotencyKey: null,
    httpStatus: null,
    detalle: null,
    registrado: false,
  };
  // 'close' se emite tanto si la respuesta termina como si el cliente corta antes.
  res.on('close', () => {
    registrarIntento(req, res);
  });
  next();
}

function rechazar(res, httpStatus, resultado, payload, detalle = null) {
  const intento = res.locals.intento;
  if (intento) {
    intento.resultado = resultado;
    intento.httpStatus = httpStatus;
    intento.detalle = detalle;
  }
  return res.status(httpStatus).json(payload);
}

// ---------------------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------------------
async function buscarPorClave(key) {
  const { rows } = await pool.query(
    'SELECT id, destinatario, direccion, request_hash FROM envios WHERE idempotency_key = $1',
    [key]
  );
  return rows[0] || null;
}

// Devuelve la fila creada, o null si otra solicitud con la misma clave se adelanto.
// ON CONFLICT DO NOTHING hace que, ante dos INSERT simultaneos con la misma clave, el
// segundo espere a que el primero confirme y luego no inserte nada.
async function insertarEnvio({ key, requestHash, destinatario, direccion }) {
  const { rows } = await pool.query(
    `INSERT INTO envios (idempotency_key, request_hash, destinatario, direccion, instancia_creadora)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, destinatario, direccion, request_hash`,
    [key, requestHash, destinatario, direccion, INSTANCE_ID]
  );
  return rows[0] || null;
}

function validarCuerpo(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'El cuerpo debe ser un objeto JSON con destinatario y direccion' };
  }
  const { destinatario, direccion } = body;
  if (typeof destinatario !== 'string' || typeof direccion !== 'string') {
    return { error: 'destinatario y direccion son obligatorios y deben ser texto (string)' };
  }
  const dest = destinatario.trim();
  const dir = direccion.trim();
  if (dest.length === 0 || dir.length === 0) {
    return { error: 'destinatario y direccion no pueden estar vacios' };
  }
  if (dest.length > MAX_DESTINATARIO || dir.length > MAX_DIRECCION) {
    return { error: `destinatario admite hasta ${MAX_DESTINATARIO} caracteres y direccion hasta ${MAX_DIRECCION}` };
  }
  return { destinatario: dest, direccion: dir };
}

// Retardo de prueba: solo si el servicio fue arrancado con ENABLE_TEST_DELAY=true y la
// solicitud trae X-Test-Delay-Ms. En produccion ambas condiciones son falsas.
function retardoSolicitado(req) {
  if (!ENABLE_TEST_DELAY) return 0;
  const ms = Number.parseInt(req.get('x-test-delay-ms'), 10);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_TEST_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Aplicacion
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// Toda respuesta de esta replica identifica quien la emitio.
app.use((req, res, next) => {
  res.set('X-Instance-ID', INSTANCE_ID);
  next();
});
app.use(bitacora);
app.use(express.json({ limit: '10kb' }));

// Liveness: no toca la base. Lo usa el healthcheck de Docker.
app.get('/live', (req, res) => {
  res.json({ status: 'live', instance: INSTANCE_ID });
});

// Readiness: ejecuta una consulta real contra PostgreSQL.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', instance: INSTANCE_ID });
  } catch (err) {
    console.error(`[${INSTANCE_ID}] health: ${err.message}`);
    rechazar(res, 503, 'ERROR_BASE_DATOS', { status: 'error', database: 'disconnected', instance: INSTANCE_ID });
  }
});

app.post('/envios', async (req, res) => {
  const intento = res.locals.intento;
  const key = req.get('idempotency-key');

  if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
    return rechazar(
      res,
      400,
      'RECHAZADO_VALIDACION',
      {
        error: 'IDEMPOTENCY_KEY_INVALIDA',
        mensaje: 'Envie la cabecera Idempotency-Key (8 a 128 caracteres: letras, numeros, . _ : -). Use un valor nuevo por cada envio nuevo y el mismo valor al reintentar.',
      },
      key ? 'idempotency_key con formato invalido' : 'falta Idempotency-Key'
    );
  }
  intento.idempotencyKey = key;

  const datos = validarCuerpo(req.body);
  if (datos.error) {
    return rechazar(res, 400, 'RECHAZADO_VALIDACION', { error: 'DATOS_INVALIDOS', mensaje: datos.error }, 'cuerpo invalido');
  }

  const requestHash = sha256(JSON.stringify([datos.destinatario, datos.direccion]));

  // 1) Reintento secuencial: la operacion ya fue registrada (por esta u otra replica).
  let envio = await buscarPorClave(key);
  let repetido = envio !== null;

  // 2) Operacion nueva, o dos solicitudes simultaneas: decide el UNIQUE de PostgreSQL.
  if (!envio) {
    envio = await insertarEnvio({ key, requestHash, ...datos });
    if (!envio) {
      envio = await buscarPorClave(key); // otra solicitud con la misma clave gano la carrera
      repetido = true;
    }
  }

  intento.envioId = envio.id;

  // Misma clave con otros datos: no es un reintento, es un uso incorrecto de la clave.
  if (envio.request_hash !== requestHash) {
    return rechazar(
      res,
      422,
      'CLAVE_REUTILIZADA',
      {
        error: 'IDEMPOTENCY_KEY_REUTILIZADA',
        mensaje: 'Esa Idempotency-Key ya se uso con otros datos. Genere una clave nueva para un envio distinto.',
        id: envio.id,
      },
      'misma clave con destinatario o direccion distintos'
    );
  }

  intento.resultado = repetido ? 'REPETIDO' : 'CREADO';
  intento.httpStatus = repetido ? 200 : 201;

  const retardoMs = retardoSolicitado(req);
  if (retardoMs > 0) intento.detalle = `retardo_simulado_ms=${retardoMs}`;

  // El intento queda anotado ANTES de la espera: aunque el cliente se rinda, la evidencia existe.
  await registrarIntento(req, res);

  // PRUEBA DE TIMEOUT: el envio ya esta confirmado en PostgreSQL; solo se demora la respuesta.
  if (retardoMs > 0) await sleep(retardoMs);

  if (repetido) res.set('Idempotent-Replayed', 'true');
  return res.status(intento.httpStatus).json({
    id: envio.id,
    destinatario: envio.destinatario,
    direccion: envio.direccion,
  });
});

// Consulta de envios registrados (sirve para comprobar que existe uno solo).
app.get('/envios', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, destinatario, direccion, instancia_creadora,
            to_char(creado_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS creado_en
       FROM envios ORDER BY id LIMIT 100`
  );
  res.json(rows);
});

app.get('/envios/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return rechazar(res, 400, 'RECHAZADO_VALIDACION', { error: 'ID_INVALIDO' }, 'id no numerico');
  }
  const { rows } = await pool.query(
    `SELECT id, destinatario, direccion, instancia_creadora,
            to_char(creado_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS creado_en
       FROM envios WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) {
    return rechazar(res, 404, 'ENVIO_NO_ENCONTRADO', { error: 'ENVIO_NO_ENCONTRADO' });
  }
  return res.json(rows[0]);
});

// Consulta de la bitacora. Filtros opcionales: envio_id, idempotency_key, limit (maximo 500).
app.get('/intentos', async (req, res) => {
  const condiciones = [];
  const valores = [];

  if (req.query.envio_id !== undefined) {
    const envioId = Number(req.query.envio_id);
    if (!Number.isInteger(envioId)) return res.status(400).json({ error: 'envio_id debe ser entero' });
    valores.push(envioId);
    condiciones.push(`envio_id = $${valores.length}`);
  }
  if (typeof req.query.idempotency_key === 'string') {
    valores.push(req.query.idempotency_key);
    condiciones.push(`idempotency_key = $${valores.length}`);
  }
  const limite = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
  valores.push(limite);
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT id,
              to_char(ocurrio_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ocurrio_en,
              request_id, metodo, ruta, instancia, ip_cliente, idempotency_key,
              resultado, envio_id, http_status, detalle
         FROM intentos ${where}
        ORDER BY id DESC LIMIT $${valores.length}
     ) ultimos ORDER BY id`,
    valores
  );
  res.json(rows);
});

app.use((req, res) => {
  rechazar(res, 404, 'RUTA_NO_ENCONTRADA', { error: 'RUTA_NO_ENCONTRADA' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) {
    // JSON mal formado o cuerpo demasiado grande. No se registra err.message: podria citar el cuerpo.
    return rechazar(res, status, 'RECHAZADO_VALIDACION', { error: 'SOLICITUD_INVALIDA', mensaje: 'El cuerpo de la solicitud no es valido' }, err.type || 'solicitud invalida');
  }

  console.error(`[${INSTANCE_ID}] error interno en ${req.method} ${req.path}: ${err.message}`);
  return rechazar(res, 500, 'ERROR_INTERNO', { error: 'ERROR_INTERNO' }, 'excepcion no controlada');
});

// ---------------------------------------------------------------------------
// Arranque y apagado ordenado (docker stop envia SIGTERM)
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] escuchando en el puerto ${PORT} | retardo de prueba habilitado: ${ENABLE_TEST_DELAY}`);
});

function apagar(senal) {
  console.log(`[${INSTANCE_ID}] ${senal} recibida, cerrando`);
  setTimeout(() => process.exit(1), 8000).unref();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
