# envios-app (RutaExpress)

Servicio de registro de envios con Node.js, Express y PostgreSQL, desplegado con Docker Compose y Nginx.
Evita envios duplicados cuando un cliente reintenta una solicitud, conserva sus datos al recrear contenedores,
sigue atendiendo si una replica se detiene y limita las rafagas de solicitudes dejando evidencia de los rechazos.

## Arquitectura

```
Cliente (Postman, curl, scripts/cliente-pruebas.js)
        |
        v  localhost:8080
   +---------+     round robin      +------+   +------+   +------+
   |  nginx  | -------------------> | app1 |   | app2 |   | app3 |     puerto 3000 (solo interno)
   +---------+   limit_req 2r/s     +------+   +------+   +------+
   logs en volumen nginx_logs            \         |         /
                                          v        v        v
                                       +------------------------+
   DBeaver -> localhost:15432 -------> |  db (PostgreSQL 16)    |  volumen db_data
                                       +------------------------+
```

| Servicio | Imagen | Puertos en el host | Notas |
|---|---|---|---|
| nginx | nginx:1.27-alpine | 8080 -> 80 | Unico punto de entrada. Reparte entre app1, app2, app3. |
| app1, app2, app3 | `<DOCKERHUB_USER>/envios-app:<APP_VERSION>` | ninguno (3000 interno) | Misma imagen y misma base; solo cambia `INSTANCE_ID`. |
| db | postgres:16-alpine | 127.0.0.1:15432 -> 5432 | Datos en el volumen `db_data`. La estructura sale de `db/init.sql`. |

## Puesta en marcha (sin modificar codigo)

Requisitos: Docker con Compose v2. Node 18+ solo si se usa el cliente de pruebas.

```
Copy-Item .env.example .env        # Linux/macOS: cp .env.example .env
docker compose up -d
docker compose ps
curl.exe http://localhost:8080/health
```

`docker compose up` descarga la imagen publicada en Docker Hub si no esta en el equipo. La primera vez PostgreSQL ejecuta
`db/init.sql` y crea las tablas. Para empezar de cero (borra los datos): `docker compose down -v`.

Conexion desde DBeaver: host `localhost`, puerto `15432`, base y usuario segun `.env` (`DB_NAME`, `DB_USER`, `DB_PASSWORD`).
En `db/consultas.sql` hay consultas listas para verificar los resultados.

## Contrato de la API

| Metodo y ruta | Descripcion |
|---|---|
| `POST /envios` | Cabecera obligatoria `Idempotency-Key`. Cuerpo JSON con `destinatario` y `direccion` (ambos texto). |
| `GET /health` | Consulta real a PostgreSQL. Responde `{status, database, instance}`. 503 si la base no responde. |
| `GET /envios`, `GET /envios/:id` | Consulta de envios registrados. |
| `GET /intentos` | Consulta de la bitacora. Filtros: `idempotency_key`, `envio_id`, `limit`. |

Respuestas de `POST /envios`:

| Situacion | HTTP | Cuerpo | Cabeceras utiles |
|---|---|---|---|
| Envio nuevo | 201 | `{id, destinatario, direccion}` | `X-Instance-ID` |
| Reintento de una operacion ya registrada | 200 | el mismo `{id, destinatario, direccion}` | `X-Instance-ID`, `Idempotent-Replayed: true` |
| Falta la clave, formato invalido o datos invalidos | 400 | `{error, mensaje}` | `X-Instance-ID` |
| Misma clave con otros datos | 422 | `{error, mensaje, id}` | `X-Instance-ID` |
| Exceso de solicitudes (lo responde Nginx) | 429 | - | - |

Toda respuesta de una replica incluye `X-Instance-ID`.

Ejemplo (PowerShell no conserva bien las comillas del JSON, por eso se envia un archivo):

```
curl.exe -i -X POST http://localhost:8080/envios -H "Content-Type: application/json" -H "Idempotency-Key: pedido-0001" --data-binary "@scripts/envio-ana.json"
```

## Diseno de la solucion

### Modelo de datos (`db/init.sql`)

Dos tablas:

- **envios**: un registro por operacion de negocio. Guarda `idempotency_key` con restriccion `UNIQUE`, un hash de los datos
  (`request_hash`), `destinatario`, `direccion`, la replica que lo creo y la hora de creacion.
- **intentos**: bitacora append-only de cada solicitud que llega al backend. Guarda hora con microsegundos (`clock_timestamp()`),
  `request_id`, metodo, ruta, replica, IP del cliente, `idempotency_key`, `resultado`, `envio_id`, `http_status` y un `detalle`.
  Nunca guarda el cuerpo de la solicitud.

### Mecanismo contra duplicados: Idempotency-Key + restriccion UNIQUE en PostgreSQL

El cliente genera una clave por cada **operacion** (cada vez que un trabajador decide registrar un envio) y la envia en la
cabecera `Idempotency-Key`. Si la solicitud falla por timeout, el cliente reintenta con **la misma clave**.

1. La replica busca la clave en `envios`. Si existe, responde con el envio original (200) y no inserta nada.
2. Si no existe, hace `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING ...`.
3. Si dos solicitudes con la misma clave llegan al mismo tiempo a replicas distintas, PostgreSQL deja pasar solo un `INSERT`:
   el segundo espera a que el primero confirme y luego no inserta nada (`RETURNING` vacio). Esa replica consulta el envio ya
   creado y responde 200.

Por que esta eleccion:

- La garantia la da la base de datos, no la memoria de una replica. Con tres replicas, un cache en memoria o un bloqueo local
  no sirven: el reintento puede caer en otra instancia o despues de un reinicio. El `UNIQUE` funciona igual con 1 o con 30 replicas.
- Esta dentro de la misma fila del envio, de modo que no puede quedar un envio sin su clave ni una clave sin envio (no hay
  transaccion entre dos tablas que pueda fallar a medias).
- Una sola solicitud contra la base decide el resultado, tambien bajo concurrencia.

**Como distingue un reintento de un envio nuevo intencional.** Los datos no sirven para distinguirlos: dos envios legitimos
pueden tener el mismo destinatario y la misma direccion. Lo que los distingue es la intencion, que expresa la clave:
mismo valor = reintento de la misma operacion; valor nuevo = envio nuevo, aunque los datos sean iguales.
Si alguien reutiliza una clave con otros datos, el servicio responde 422 en lugar de crear o devolver un envio equivocado
(se compara `request_hash`).

La clave es obligatoria. Sin ella no hay forma de distinguir un reintento de un envio nuevo, y aceptar solicitudes sin clave
permitiria justo el duplicado que se quiere evitar.

### Registro de intentos y evidencia

| Lo que se quiere probar | Donde queda | Quien lo genera |
|---|---|---|
| Resultado del procesamiento y HTTP emitido | tabla `intentos` (consulta con DBeaver o `GET /intentos`) | la replica |
| Que el envio existia antes del timeout | `envios.creado_en` y `intentos.ocurrio_en`, ambos anteriores al instante en que el cliente se rinde | la replica |
| Timeouts observados por el cliente | `evidencias/logs/cliente.jsonl` (`observado_por_cliente: TIMEOUT_CLIENTE`) | `scripts/cliente-pruebas.js` |
| Rechazos HTTP 429 (nunca llegan al backend) | `rechazos_429.jsonl` en el volumen `nginx_logs` | Nginx |
| Todo el trafico visto por Nginx | `acceso.jsonl` en el volumen `nginx_logs` | Nginx |

El resultado del servidor y lo observado por el cliente pueden diferir: en la prueba de timeout el servidor registra
`CREADO / 201` y el cliente registra `TIMEOUT_CLIENTE` sin codigo HTTP. Los intentos de una misma operacion se relacionan por
`idempotency_key` y por `envio_id`. `request_id` (generado por Nginx) permite unir una fila de `intentos` con su linea en el log de Nginx.

No se anotan en `intentos` las rutas `/live` (healthcheck de Docker, cada 10 s) ni `/intentos` (la propia consulta).
El log de Nginx no contiene cuerpos ni cabeceras: solo hora, IP, metodo, ruta, codigo y tiempos.

## Pruebas

Todas se ejecutan desde la carpeta del proyecto. El cliente anota cada solicitud en `evidencias/logs/cliente.jsonl`.
Para guardar ademas la salida en un archivo: `... | Tee-Object evidencias\logs\nombre.txt`.

### 1. Timeout del cliente y recuperacion

Requiere `ENABLE_TEST_DELAY=true` en `.env` (por defecto es `false`) y recrear las replicas: `docker compose up -d`.

```
# intento inicial: el servidor registra el envio, demora 5 s la respuesta; el cliente espera solo 2 s
node scripts/cliente-pruebas.js crear --key timeout-0001 --demora 5000 --timeout 2000
# reintento con la misma clave, sin demora: lo atiende otra replica
node scripts/cliente-pruebas.js crear --key timeout-0001
# un solo envio y la historia de la operacion
node scripts/cliente-pruebas.js envios
node scripts/cliente-pruebas.js intentos --key timeout-0001
```

El timeout es real: el cliente aborta la espera (`AbortSignal.timeout`); el servidor no devuelve ningun codigo de error.
El envio ya existe cuando el cliente se rinde: `envios.creado_en` queda a una fraccion de segundo del inicio de la solicitud
(en las pruebas, menos de 200 ms), mientras que el cliente espera 2000 ms.
Nginx reparte por turnos, por lo que el reintento inmediato cae en la replica siguiente.

**Como retirar la demora.** La demora solo actua si se cumplen dos condiciones: `ENABLE_TEST_DELAY=true` en el entorno de las
replicas **y** la cabecera `X-Test-Delay-Ms` en la solicitud. Para retirarla: poner `ENABLE_TEST_DELAY=false` en `.env` y ejecutar
`docker compose up -d` (recrea las replicas; ver nota sobre IPs en Limitaciones). Con la bandera en `false` la cabecera se ignora.
El codigo esta en `src/server.js`, funcion `retardoSolicitado` y la linea `await sleep(retardoMs)`, que solo se ejecuta despues de
confirmar el registro en PostgreSQL.

### 2. Dos intentos simultaneos y envios intencionales iguales

```
node scripts/cliente-pruebas.js concurrente --key simultaneo-0001
node scripts/cliente-pruebas.js crear --key nuevo-envio-A --destinatario "Rosa Quispe" --direccion "Calle Sol 10, Cusco"
node scripts/cliente-pruebas.js crear --key nuevo-envio-B --destinatario "Rosa Quispe" --direccion "Calle Sol 10, Cusco"
```

El primer comando envia dos `POST` a la vez con la misma clave: exactamente uno responde 201 y el otro 200. Los otros dos crean
dos envios distintos (claves distintas) con los mismos datos.

### 3. Balanceo y continuidad

```
node scripts/cliente-pruebas.js health --n 12                      # respuestas de app1, app2 y app3
docker compose stop app2
node scripts/cliente-pruebas.js health --n 12                      # solo app1 y app3
docker compose start app2
node scripts/cliente-pruebas.js health --n 12                      # app2 vuelve
```

Para registrar la transicion, ejecute el `health` con mas solicitudes (`--n 40`) en una terminal y el `stop`/`start` en otra.
Cualquier solicitud lenta o con error queda en la salida y en `cliente.jsonl`. Con `proxy_connect_timeout 2s` la solicitud que
Nginx dirige a la replica caida espera hasta 2 s y se reenvia a otra; las siguientes la evitan por `max_fails`/`fail_timeout`.

### 4. Persistencia

```
node scripts/cliente-pruebas.js envios
docker compose down                       # SIN -v: borra contenedores, conserva volumenes
docker compose up -d
node scripts/cliente-pruebas.js envios    # mismos ids y datos
node scripts/cliente-pruebas.js crear --key timeout-0001      # reintento tras la recreacion: 200, mismo id
```

Comprobacion en SQL: `Get-Content db/consultas.sql | docker compose exec -T db sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB'`.
No use `down -v` en esta prueba: elimina los volumenes.

### 5. Limite de solicitudes (HTTP 429)

Nginx limita `POST /envios` a 2 solicitudes por segundo por IP, con una rafaga adicional de 4 y `nodelay`
(`nginx/nginx.conf`). Una rafaga admite 5 solicitudes de inmediato (1 por la tasa y 4 por la rafaga) y rechaza el resto con 429.

```
node scripts/cliente-pruebas.js carga --n 30                 # cantidad, duracion y conteo por codigo
node scripts/cliente-pruebas.js ritmo --n 6 --intervalo 600  # frecuencia reducida: se admiten de nuevo
node scripts/cliente-pruebas.js rechazos                     # consulta del log de rechazos
```

El limite solo aplica al metodo POST; las consultas GET no se limitan.

### 6. Registro persistente de rechazos

Nginx escribe en el volumen `nginx_logs` (carpeta `/var/log/nginx-evidencia`), en JSON, uno por linea:

- `rechazos_429.jsonl`: solo los 429. Campos: `hora`, `msec`, `ip_cliente`, `metodo`, `ruta`, `estado`, `limit_req`, `upstream`
  (vacio: la solicitud nunca llego a la aplicacion), `request_id`.
- `acceso.jsonl`: todo el trafico.

Consulta: `node scripts/cliente-pruebas.js rechazos` o
`docker compose exec nginx sh -c "cat /var/log/nginx-evidencia/rechazos_429.jsonl"`.
Persistencia: `docker compose up -d --force-recreate nginx` y volver a consultar; el archivo conserva los registros anteriores.
No se registran cuerpos ni cabeceras, por lo que no hay datos personales ni credenciales en estos archivos.

## Contenerizacion e imagen publicada

- `Dockerfile`: `node:22-alpine`, `npm ci --omit=dev` desde `package-lock.json`, usuario `app` sin privilegios, `HEALTHCHECK` en `/live`.
- `.dockerignore`: excluye `node_modules`, `.env`, `.git`, documentacion y archivos de despliegue.
- Credenciales: solo por variables de entorno (`.env`, ignorado por Git y por Docker). `.env.example` no contiene secretos reales.

Publicacion (usuario de Docker Hub: angelaguilarcontre):

```
docker build -t angelaguilarcontre/envios-app:1.0.0 -t angelaguilarcontre/envios-app:latest .
docker login
docker push angelaguilarcontre/envios-app:1.0.0
docker push angelaguilarcontre/envios-app:latest
# demostrar la descarga
docker rmi angelaguilarcontre/envios-app:1.0.0
docker pull angelaguilarcontre/envios-app:1.0.0
```

## Limitaciones conocidas

- **IP del cliente.** Con Docker Desktop, las solicitudes desde el equipo llegan a Nginx con la IP de la pasarela de Docker
  (por ejemplo `172.19.0.1`), no con la IP real. Por eso, en una prueba local, el limite "por IP" actua como limite global.
- **IP de las replicas.** Nginx usa `resolver 127.0.0.11` y `resolve` para volver a consultar los nombres cada 2 s. Si se recrean
  las tres replicas con Nginx encendido, el reparto puede tardar unos segundos en equilibrarse; `docker compose restart nginx`
  lo normaliza de inmediato.
- **Un solo Nginx y una sola base.** Tres replicas de la aplicacion no eliminan los demas puntos unicos de falla.
- **Retencion de claves.** Las claves de idempotencia se conservan mientras exista el envio; no hay expiracion.
- **Sin autenticacion.** Es un laboratorio local por HTTP; `GET /envios` expone datos de envios sin control de acceso.
- `db/init.sql` solo se ejecuta cuando el volumen `db_data` esta vacio.
