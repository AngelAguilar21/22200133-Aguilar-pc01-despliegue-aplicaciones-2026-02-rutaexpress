-- Consultas de verificacion y evidencia. Se pueden abrir en DBeaver (localhost:15432) o ejecutar con:
--   Get-Content db/consultas.sql | docker compose exec -T db sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB'
-- Todas las horas se muestran en UTC con microsegundos, para poder comparar con el log del cliente.

SELECT '--- 1. Envios registrados ---' AS consulta;
SELECT id, destinatario, direccion, instancia_creadora,
       to_char(creado_en AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS creado_en_utc,
       idempotency_key
  FROM envios
 ORDER BY id;

SELECT '--- 2. Claves repetidas en envios (debe devolver 0 filas: no hay duplicados) ---' AS consulta;
SELECT idempotency_key, count(*) AS cantidad
  FROM envios
 GROUP BY idempotency_key
HAVING count(*) > 1;

SELECT '--- 3. Total de envios y de operaciones distintas (deben coincidir) ---' AS consulta;
SELECT count(*) AS envios, count(DISTINCT idempotency_key) AS operaciones_distintas FROM envios;

SELECT '--- 4. Bitacora de intentos POST /envios agrupada por operacion, en orden cronologico ---' AS consulta;
SELECT id AS intento,
       to_char(ocurrio_en AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS ocurrio_en_utc,
       instancia, idempotency_key, resultado, envio_id, http_status, detalle
  FROM intentos
 WHERE metodo = 'POST' AND ruta = '/envios'
 ORDER BY idempotency_key NULLS FIRST, ocurrio_en, id;

SELECT '--- 5. Una operacion concreta: cambie la clave entre comillas ---' AS consulta;
SELECT i.id AS intento,
       to_char(i.ocurrio_en AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS ocurrio_en_utc,
       i.instancia, i.resultado, i.envio_id, i.http_status, i.detalle
  FROM intentos i
 WHERE i.idempotency_key = 'timeout-prueba-0001'
 ORDER BY i.ocurrio_en, i.id;

SELECT '--- 6. Resumen de resultados por replica ---' AS consulta;
SELECT instancia, resultado, count(*) AS cantidad
  FROM intentos
 GROUP BY instancia, resultado
 ORDER BY instancia, resultado;

SELECT '--- 7. Replicas que participaron en las solicitudes a /health ---' AS consulta;
SELECT instancia, count(*) AS solicitudes
  FROM intentos
 WHERE ruta = '/health'
 GROUP BY instancia
 ORDER BY instancia;

SELECT '--- 8. Rechazos 429 dentro de intentos (debe ser 0: Nginx los rechaza antes del backend; estan en su log) ---' AS consulta;
SELECT count(*) FILTER (WHERE http_status = 429) AS rechazos_429_en_intentos, count(*) AS total_intentos
  FROM intentos;

SELECT '--- 9. Cada operacion con el envio creado y sus intentos (un solo CREADO por envio) ---' AS consulta;
SELECT e.id AS envio_id, e.idempotency_key, e.instancia_creadora,
       count(*) FILTER (WHERE i.resultado = 'CREADO')   AS intentos_creado,
       count(*) FILTER (WHERE i.resultado = 'REPETIDO') AS intentos_repetido
  FROM envios e
  LEFT JOIN intentos i ON i.envio_id = e.id
 GROUP BY e.id, e.idempotency_key, e.instancia_creadora
 ORDER BY e.id;

