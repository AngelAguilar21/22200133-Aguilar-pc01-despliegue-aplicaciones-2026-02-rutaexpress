-- Estructura de datos de envios-app.
-- Se ejecuta automaticamente la PRIMERA vez que PostgreSQL arranca con el volumen vacio
-- (carpeta /docker-entrypoint-initdb.d). Para reproducirla manualmente:
--   docker compose exec -T db psql -U <DB_USER> -d <DB_NAME> < db/init.sql
-- Es idempotente (IF NOT EXISTS), por lo que puede ejecutarse mas de una vez.

-- ---------------------------------------------------------------------------
-- Tabla 1: envios
-- Un envio por cada operacion de negocio. La columna idempotency_key identifica
-- la OPERACION (la intencion del trabajador), no los datos del envio.
-- El UNIQUE es la garantia real contra duplicados: lo hace cumplir PostgreSQL,
-- por lo que funciona igual con 1 o con 30 replicas y con solicitudes simultaneas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envios (
    id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key    TEXT        NOT NULL,
    request_hash       TEXT        NOT NULL,   -- sha256 de destinatario+direccion; detecta reuso de clave con otros datos
    destinatario       TEXT        NOT NULL,
    direccion          TEXT        NOT NULL,
    instancia_creadora TEXT        NOT NULL,   -- replica que hizo el INSERT (app1, app2 o app3)
    creado_en          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT envios_idempotency_key_uk UNIQUE (idempotency_key),
    CONSTRAINT envios_destinatario_ck    CHECK (length(btrim(destinatario)) > 0),
    CONSTRAINT envios_direccion_ck       CHECK (length(btrim(direccion)) > 0)
);

-- ---------------------------------------------------------------------------
-- Tabla 2: intentos
-- Bitacora de CADA solicitud que llega al backend (aceptada, repetida, rechazada
-- o fallida). Es append-only: la aplicacion solo hace INSERT.
-- ocurrio_en usa clock_timestamp(): precision de microsegundos y avanza dentro de
-- una misma transaccion, por lo que permite ordenar eventos muy cercanos.
-- Los rechazos HTTP 429 de Nginx NO pasan por aqui (nunca llegan al backend);
-- los registra Nginx en su propio archivo persistente (ver README).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentos (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ocurrio_en       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    request_id       TEXT,                      -- X-Request-ID generado por Nginx; une esta fila con su linea en el log de Nginx
    metodo           TEXT        NOT NULL,
    ruta             TEXT        NOT NULL,
    instancia        TEXT        NOT NULL,      -- replica que atendio la solicitud
    ip_cliente       TEXT,
    idempotency_key  TEXT,                      -- permite agrupar todos los intentos de una misma operacion
    resultado        TEXT        NOT NULL,      -- CREADO | REPETIDO | CLAVE_REUTILIZADA | RECHAZADO_VALIDACION | ERROR_INTERNO | OK | ...
    envio_id         INTEGER REFERENCES envios (id),
    http_status      INTEGER,                   -- codigo que el servidor emitio; NULL si el cliente se fue antes de recibir respuesta
    detalle          TEXT                       -- nota libre (por ejemplo retardo_simulado_ms=5000). Nunca contiene el cuerpo de la solicitud
);

CREATE INDEX IF NOT EXISTS intentos_envio_idx ON intentos (envio_id, ocurrio_en);
CREATE INDEX IF NOT EXISTS intentos_key_idx   ON intentos (idempotency_key, ocurrio_en);
CREATE INDEX IF NOT EXISTS intentos_ts_idx    ON intentos (ocurrio_en);
