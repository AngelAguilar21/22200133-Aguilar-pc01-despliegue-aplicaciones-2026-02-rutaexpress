#!/usr/bin/env node
'use strict';

// Cliente de pruebas de envios-app (representa al frontend). Requiere Node 18 o superior.
// Cada solicitud se anota en evidencias/logs/cliente.jsonl: es el registro de lo que el CLIENTE observo
// (respuesta, timeout o error de red), que puede diferir de lo que el servidor registro.
//
// Uso: node scripts/cliente-pruebas.js <comando> [--opcion valor]
//   health       [--n 12] [--intervalo 600]
//   crear        [--key K] [--destinatario T] [--direccion T] [--demora MS] [--timeout MS]
//   concurrente  [--key K] [--destinatario T] [--direccion T]
//   carga        [--n 30] [--key K]
//   ritmo        [--n 8] [--intervalo 600] [--espera 3000] [--key K]
//   intentos     [--key K] [--envio ID] [--limit N]
//   envios
//   rechazos     (lee el log de Nginx desde el volumen; requiere ejecutarse en la carpeta del proyecto)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const RAIZ = path.join(__dirname, '..');
const LOG_FILE = process.env.CLIENTE_LOG || path.join(RAIZ, 'evidencias', 'logs', 'cliente.jsonl');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nuevaClave = () => `envio-${crypto.randomUUID()}`;

function parseArgs(argv) {
  const [cmd, ...resto] = argv;
  const opts = {};
  for (let i = 0; i < resto.length; i += 1) {
    if (!resto[i].startsWith('--')) continue;
    const nombre = resto[i].slice(2);
    const siguiente = resto[i + 1];
    opts[nombre] = siguiente !== undefined && !siguiente.startsWith('--') ? resto[(i += 1)] : 'true';
  }
  return { cmd, opts };
}

function anotar(registro) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(registro)}\n`);
}

function intentarJson(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

// Una solicitud HTTP. Nunca lanza: devuelve siempre un registro con lo que el cliente observo.
async function solicitar({ escenario, metodo, ruta, key, body, timeoutMs, demoraMs }) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (demoraMs) headers['X-Test-Delay-Ms'] = String(demoraMs);

  const reg = {
    inicio: new Date().toISOString(),
    escenario,
    metodo,
    ruta,
    idempotency_key: key || null,
    timeout_cliente_ms: timeoutMs || null,
    demora_solicitada_ms: demoraMs || null,
  };
  const t0 = performance.now();
  try {
    const res = await fetch(BASE_URL + ruta, {
      method: metodo,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const texto = await res.text();
    Object.assign(reg, {
      observado_por_cliente: 'RESPUESTA',
      http_status: res.status,
      instancia: res.headers.get('x-instance-id'),
      reintento_reconocido: res.headers.get('idempotent-replayed') === 'true',
      cuerpo: intentarJson(texto),
    });
  } catch (err) {
    const esTimeout = err.name === 'TimeoutError';
    Object.assign(reg, {
      observado_por_cliente: esTimeout ? 'TIMEOUT_CLIENTE' : 'ERROR_RED',
      http_status: null,
      instancia: null,
      detalle: esTimeout ? `el cliente dejo de esperar a los ${timeoutMs} ms` : err.cause?.code || err.message,
    });
  }
  reg.duracion_ms = Math.round(performance.now() - t0);
  reg.fin = new Date().toISOString();
  anotar(reg);
  return reg;
}

function linea(reg) {
  const hora = reg.inicio.slice(11, 23);
  const clave = reg.idempotency_key ? ` clave=${reg.idempotency_key}` : '';
  if (reg.observado_por_cliente === 'RESPUESTA') {
    const marca = reg.reintento_reconocido ? ' (reintento reconocido, no se creo otro envio)' : '';
    const id = reg.cuerpo && reg.cuerpo.id !== undefined ? ` id=${reg.cuerpo.id}` : '';
    return `${hora}Z ${reg.metodo} ${reg.ruta}${clave} -> HTTP ${reg.http_status}${id} instancia=${reg.instancia ?? '-'} ${reg.duracion_ms} ms${marca}`;
  }
  return `${hora}Z ${reg.metodo} ${reg.ruta}${clave} -> ${reg.observado_por_cliente} (${reg.detalle}) ${reg.duracion_ms} ms`;
}

function contar(regs, campo) {
  const cuenta = {};
  for (const r of regs) {
    const valor = r[campo] === null || r[campo] === undefined ? r.observado_por_cliente : r[campo];
    cuenta[valor] = (cuenta[valor] || 0) + 1;
  }
  return cuenta;
}

const cuerpoEnvio = (o) => ({
  destinatario: o.destinatario || 'Ana Torres',
  direccion: o.direccion || 'Av. Los Olivos 123, Lima',
});

// ---------------------------------------------------------------------------
const comandos = {
  async health(o) {
    const n = Number(o.n) || 12;
    const intervalo = Number(o.intervalo) || 600;
    console.log(`GET /health x${n} cada ${intervalo} ms (${(1000 / intervalo).toFixed(2)} solicitudes/s)`);
    const regs = [];
    for (let i = 0; i < n; i += 1) {
      const reg = await solicitar({ escenario: 'balanceo', metodo: 'GET', ruta: '/health', timeoutMs: 5000 });
      console.log(linea(reg));
      regs.push(reg);
      if (i < n - 1) await sleep(intervalo);
    }
    console.log('\nResumen por instancia:', contar(regs, 'instancia'));
    console.log('Resumen por resultado:', contar(regs, 'http_status'));
  },

  async crear(o) {
    const key = o.key || nuevaClave();
    const reg = await solicitar({
      escenario: 'crear',
      metodo: 'POST',
      ruta: '/envios',
      key,
      body: cuerpoEnvio(o),
      timeoutMs: Number(o.timeout) || 10000,
      demoraMs: Number(o.demora) || 0,
    });
    console.log(linea(reg));
    if (reg.observado_por_cliente === 'TIMEOUT_CLIENTE') {
      console.log(`\nEl cliente no recibio respuesta, pero el envio pudo registrarse. Reintente con la MISMA clave:\n  node scripts/cliente-pruebas.js crear --key ${key}`);
    }
  },

  async concurrente(o) {
    const key = o.key || nuevaClave();
    console.log(`Dos POST /envios simultaneos con la misma clave ${key}`);
    const regs = await Promise.all(
      [1, 2].map(() => solicitar({ escenario: 'concurrente', metodo: 'POST', ruta: '/envios', key, body: cuerpoEnvio(o), timeoutMs: 10000 }))
    );
    regs.forEach((r) => console.log(linea(r)));
    const creados = regs.filter((r) => r.http_status === 201).length;
    console.log(`\nRespuestas 201 (envio creado): ${creados}. Debe ser exactamente 1.`);
    await comandos.intentos({ key });
  },

  async carga(o) {
    const n = Number(o.n) || 30;
    const key = o.key || `carga-${Date.now()}`;
    console.log(`Rafaga de ${n} POST /envios simultaneos (misma clave ${key}: solo el primero crea un envio)`);
    const t0 = performance.now();
    const regs = await Promise.all(
      Array.from({ length: n }, () =>
        solicitar({ escenario: 'rafaga', metodo: 'POST', ruta: '/envios', key, body: { destinatario: 'Prueba de carga', direccion: 'Calle de prueba 1' }, timeoutMs: 10000 })
      )
    );
    const duracion = Math.round(performance.now() - t0);
    const admitidas = regs.filter((r) => r.http_status !== 429);
    const tiempos = admitidas.map((r) => r.duracion_ms).sort((a, b) => a - b);
    const mediana = tiempos.length ? tiempos[Math.floor(tiempos.length / 2)] : 0;
    console.log(`\nSolicitudes enviadas : ${n}`);
    console.log(`Duracion total       : ${duracion} ms`);
    console.log('Conteo por codigo    :', contar(regs, 'http_status'));
    console.log(`Admitidas (no 429)   : ${admitidas.length}, mediana de respuesta ${mediana} ms (sin encolarse: nodelay)`);
  },

  async ritmo(o) {
    const n = Number(o.n) || 8;
    const intervalo = Number(o.intervalo) || 600;
    const espera = o.espera === undefined ? 3000 : Number(o.espera);
    const key = o.key || `ritmo-${Date.now()}`;
    console.log(`Esperando ${espera} ms para que Nginx recupere la capacidad de rafaga...`);
    await sleep(espera);
    console.log(`${n} POST /envios cada ${intervalo} ms (${(1000 / intervalo).toFixed(2)} solicitudes/s, menos de 2/s)`);
    const regs = [];
    for (let i = 0; i < n; i += 1) {
      const reg = await solicitar({ escenario: 'ritmo-reducido', metodo: 'POST', ruta: '/envios', key, body: { destinatario: 'Prueba de ritmo', direccion: 'Calle de prueba 2' }, timeoutMs: 10000 });
      console.log(linea(reg));
      regs.push(reg);
      if (i < n - 1) await sleep(intervalo);
    }
    console.log('\nConteo por codigo:', contar(regs, 'http_status'));
  },

  async intentos(o) {
    const params = new URLSearchParams();
    if (o.key) params.set('idempotency_key', o.key);
    if (o.envio) params.set('envio_id', o.envio);
    if (o.limit) params.set('limit', o.limit);
    const res = await fetch(`${BASE_URL}/intentos?${params}`);
    const filas = await res.json();
    console.log('\nTabla intentos (servidor):');
    console.table(
      filas.map((f) => ({
        id: f.id,
        ocurrio_en: f.ocurrio_en.slice(11),
        metodo: f.metodo,
        ruta: f.ruta,
        instancia: f.instancia,
        resultado: f.resultado,
        envio_id: f.envio_id,
        http: f.http_status,
        detalle: f.detalle,
      }))
    );
  },

  async envios() {
    const res = await fetch(`${BASE_URL}/envios`);
    console.table(await res.json());
  },

  async rechazos() {
    const salida = execFileSync('docker', ['compose', 'exec', '-T', 'nginx', 'cat', '/var/log/nginx-evidencia/rechazos_429.jsonl'], {
      cwd: RAIZ,
      encoding: 'utf8',
    });
    const filas = salida
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    console.log('Rechazos HTTP 429 registrados por Nginx (archivo persistente en el volumen nginx_logs):');
    console.table(
      filas.map((f) => ({
        hora_utc: new Date(Number(f.msec) * 1000).toISOString(),
        ip_cliente: f.ip_cliente,
        metodo: f.metodo,
        ruta: f.ruta,
        estado: f.estado,
        limit_req: f.limit_req,
        llego_al_backend: f.upstream ? 'si' : 'no',
      }))
    );
    console.log(`Total de rechazos 429: ${filas.length}`);
  },
};

(async () => {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!comandos[cmd]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
  try {
    await comandos[cmd](opts);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
