# Indice de evidencias

Capturas en `evidencias/capturas/`, salidas de texto en `evidencias/logs/`.
`evidencias/logs/cliente.jsonl` lo genera `scripts/cliente-pruebas.js` y es el registro de lo que el cliente observo.

Marcar cada fila cuando la captura exista. Cada captura debe mostrar la fecha y hora del sistema o del propio comando.

| ID | Archivo | Que debe verse | Que demuestra |
|---|---|---|---|
| E01 | capturas/E01-versiones.png | `docker --version`, `docker compose version`, `node --version` | Entorno de trabajo |
| E02 | capturas/E02-estructura-repo.png | Arbol del proyecto y `git ls-files` sin `.env` | Entrega de Dockerfile, .dockerignore, dependencias y .env.example; secretos fuera del repositorio |
| E03 | capturas/E03-build.png | `docker build` terminado sin errores | Imagen construida |
| E04 | capturas/E04-usuario-no-root.png | `docker compose exec app1 id` con usuario `app` | Aplicacion sin root |
| E05 | capturas/E05-imagen-sin-secretos.png | Contenido de `/app` sin `.env` y variables de la imagen sin `DB_*` | Credenciales fuera de la imagen |
| E06 | capturas/E06-docker-push.png | `docker push` de la version 1.0.0 | Publicacion versionada |
| E07 | capturas/E07-dockerhub.png | Pagina del repositorio en Docker Hub con la etiqueta 1.0.0 | Imagen publica y versionada |
| E08 | capturas/E08-docker-pull.png | `docker rmi` seguido de `docker pull` | Descarga de la imagen |
| E09 | capturas/E09-compose-ps.png | `docker compose ps` con los cinco servicios y sus puertos | 8080->80, 15432->5432, replicas en 3000/tcp sin publicar |
| E10 | capturas/E10-volumenes.png | `docker volume ls` | Volumenes `db_data` y `nginx_logs` |
| E11 | capturas/E11-dbeaver.png | Conexion a localhost:15432 y tablas `envios` e `intentos` | Acceso desde DBeaver |
| E12 | capturas/E12-health.png | Respuesta de `/health` y cabecera `X-Instance-ID` | Consulta real a la base e identificacion de replica |
| E13 | capturas/E13-demora-activada.png | `.env` con `ENABLE_TEST_DELAY=true` y recreacion de replicas | Demora activada solo para la prueba |
| E14 | capturas/E14-timeout-cliente.png | `crear --demora 5000 --timeout 2000` con `TIMEOUT_CLIENTE` | Timeout generado por el cliente, sin codigo HTTP de error |
| E15 | capturas/E15-envio-previo-al-timeout.png | `envios` y fila `CREADO` de `intentos` con su hora | El registro se completo antes del timeout |
| E16 | capturas/E16-reintento-otra-replica.png | `crear --key` con la misma clave: HTTP 200, otra instancia, mismo id | Reintento atendido por otra replica sin duplicar |
| E17 | capturas/E17-un-solo-envio.png | `db/consultas.sql`, consultas 2, 3 y 5 | Un solo envio y la historia de sus intentos |
| E18 | capturas/E18-demora-retirada.png | `.env` con `false`, recreacion y solicitud con demora que ya no demora | Retiro de la demora |
| E19 | capturas/E19-simultaneos.png | `concurrente`: un 201 y un 200, instancias distintas | Duplicado evitado bajo concurrencia |
| E20 | capturas/E20-envios-intencionales.png | DBeaver con dos envios de mismos datos y distinto id | Envio nuevo intencional distinto de un reintento |
| E21 | capturas/E21-balanceo.png | `health --n 12` con resumen de app1, app2 y app3 | Reparto entre tres replicas |
| E22 | capturas/E22-app2-detenida.png | `docker compose stop app2` y `health` solo con app1 y app3, con errores si hubo | Continuidad con una replica caida |
| E23 | capturas/E23-app2-restablecida.png | `docker compose start app2` y `health` con app2 de nuevo | Replica reincorporada |
| E24 | capturas/E24-envios-antes.png | DBeaver con al menos tres envios | Datos antes de recrear |
| E25 | capturas/E25-recreacion.png | `docker compose down` y `up -d` sin `-v` | Contenedores recreados, volumenes conservados |
| E26 | capturas/E26-envios-despues.png | DBeaver con los mismos ids y datos | Persistencia |
| E27 | capturas/E27-reintento-tras-recreacion.png | `crear --key` de una operacion anterior: 200, mismo id, mismo conteo | Sin duplicado despues de recrear |
| E28 | capturas/E28-nginx-limit-req.png | `nginx/nginx.conf` con `rate=2r/s`, `burst=4`, `nodelay`, `limit_req_status 429` | Configuracion del limite |
| E29 | capturas/E29-rafaga.png | `carga --n 30`: cantidad, duracion y conteo por codigo | Rafaga con rechazos 429 |
| E30 | capturas/E30-ritmo-reducido.png | `ritmo`: solicitudes admitidas otra vez | Recuperacion al reducir la frecuencia |
| E31 | capturas/E31-log-rechazos.png | `rechazos`: hora, IP, metodo, ruta, codigo | Rechazos consultables, anteriores al backend |
| E32 | capturas/E32-log-persistente.png | `up -d --force-recreate nginx` y la misma consulta con el mismo total | Registro persistente tras recrear Nginx |
| E33 | capturas/E33-429-fuera-de-intentos.png | `db/consultas.sql`, consulta 8, con 0 rechazos 429 en `intentos` | Los 429 nunca llegaron al backend |
| E34 | capturas/E34-repositorio.png | Repositorio en GitHub con la estructura completa | Entrega |

Respuestas a las preguntas de analisis: `respuestas/respuestas-analisis.txt`.
