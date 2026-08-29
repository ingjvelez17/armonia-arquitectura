/**
 * Prueba de carga para los requisitos NO funcionales.
 *
 * Mide latencia (p50/p95/p99), rendimiento y tasa de error. Los resultados
 * alimentan la seccion de "verificacion de requisitos no funcionales" del
 * informe.
 *
 * Levanta SU PROPIA malla en puertos 92xx con la limitacion de tasa elevada.
 * Es deliberado: el limitador de 300 peticiones/minuto protege la produccion,
 * pero aqui mediria el limitador en vez del sistema. Asi la prueba es
 * reproducible y no interfiere con una malla de demostracion ya levantada.
 *
 * Uso:  npm run carga
 *       node scripts/prueba-carga.js <concurrencia> <segundos>
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = { gateway: 9280, catalogo: 9281, reservas: 9282, pagos: 9283, notificaciones: 9284, broker: 9285 };
const BASE = `http://127.0.0.1:${P.gateway}`;
const CLAVE = 'panel-interno';
const CONCURRENCIA = Number(process.argv[2] ?? 25);
const SEGUNDOS = Number(process.argv[3] ?? 8);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTORNO = {
  ...process.env,
  LOG_LEVEL: 'error',
  LIMITE_RPM: '5000000',   // se desactiva de facto el Throttling para esta medicion
  TASA_FALLO_PAGOS: '0',
  PUERTO_GATEWAY: String(P.gateway), PUERTO_CATALOGO: String(P.catalogo),
  PUERTO_RESERVAS: String(P.reservas), PUERTO_PAGOS: String(P.pagos),
  PUERTO_NOTIFICACIONES: String(P.notificaciones), PUERTO_BROKER: String(P.broker),
  URL_CATALOGO: `http://127.0.0.1:${P.catalogo}`, URL_RESERVAS: `http://127.0.0.1:${P.reservas}`,
  URL_PAGOS: `http://127.0.0.1:${P.pagos}`, URL_NOTIFICACIONES: `http://127.0.0.1:${P.notificaciones}`,
  URL_BROKER: `http://127.0.0.1:${P.broker}`,
};

const SERVICIOS = [
  'services/broker/index.js', 'services/catalogo/index.js', 'services/pagos/index.js',
  'services/reservas/index.js', 'services/notificaciones/index.js', 'services/gateway/index.js',
];
const procesos = [];

async function levantarMalla() {
  for (const relativa of SERVICIOS) {
    procesos.push(spawn(process.execPath, [path.join(RAIZ, relativa)], { env: ENTORNO, stdio: 'ignore' }));
    await dormir(200);
  }
  for (let i = 0; i < 40; i += 1) {
    try {
      const salud = await fetch(`${BASE}/api/salud`).then((r) => r.json());
      if (salud.estadoGeneral === 'operativo') return;
    } catch { /* aun no responde */ }
    await dormir(500);
  }
  throw new Error('la malla de prueba no llego a estar operativa');
}

const apagarMalla = () => { for (const proceso of procesos) proceso.kill('SIGTERM'); };
process.on('SIGINT', () => { apagarMalla(); process.exit(1); });

/* ==================================================================== */

const percentil = (muestras, p) => {
  if (!muestras.length) return 0;
  const orden = [...muestras].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.floor((p / 100) * orden.length))];
};

async function medir(nombre, escenario, { concurrencia = CONCURRENCIA, segundos = SEGUNDOS } = {}) {
  const latencias = [];
  let exitos = 0, errores = 0, limitadas = 0;
  const fin = Date.now() + segundos * 1000;

  const trabajador = async () => {
    while (Date.now() < fin) {
      const inicio = Date.now();
      try {
        const estado = await escenario();
        latencias.push(Date.now() - inicio);
        if (estado === 429) limitadas += 1;
        else if (estado >= 400) errores += 1;
        else exitos += 1;
      } catch {
        errores += 1;
      }
    }
  };

  const arranque = Date.now();
  await Promise.all(Array.from({ length: concurrencia }, trabajador));
  const duracion = (Date.now() - arranque) / 1000;
  const total = exitos + errores + limitadas;

  return {
    escenario: nombre,
    peticiones: total,
    rps: Number((total / duracion).toFixed(1)),
    p50: percentil(latencias, 50),
    p95: percentil(latencias, 95),
    p99: percentil(latencias, 99),
    max: Math.max(0, ...latencias),
    exitos,
    errores,
    tasaErrorPct: Number(((errores / Math.max(1, total)) * 100).toFixed(2)),
  };
}

const get = (ruta) => fetch(BASE + ruta, { headers: { 'x-api-key': CLAVE } }).then((r) => r.status);
const post = (ruta, cuerpo) => fetch(BASE + ruta, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': CLAVE, 'idempotency-key': randomUUID() },
  body: JSON.stringify(cuerpo),
}).then((r) => r.status);

function imprimirTabla(filas) {
  const columnas = ['escenario', 'peticiones', 'rps', 'p50', 'p95', 'p99', 'max', 'exitos', 'errores', 'tasaErrorPct'];
  const anchos = columnas.map((col) => Math.max(col.length, ...filas.map((f) => String(f[col]).length)));
  const linea = (celdas) => '  ' + celdas.map((c, i) => String(c).padEnd(anchos[i])).join('  ');

  console.log(linea(columnas));
  console.log('  ' + anchos.map((a) => '-'.repeat(a)).join('  '));
  for (const fila of filas) console.log(linea(columnas.map((col) => fila[col])));
}

/* ==================================================================== */

async function main() {
  console.log('\n  PRUEBA DE CARGA - Armonia S.A.S.');
  console.log(`  concurrencia: ${CONCURRENCIA} | duracion por escenario: ${SEGUNDOS}s | destino: ${BASE}`);
  console.log('  levantando malla dedicada en puertos 92xx...');
  await levantarMalla();
  console.log('  malla operativa\n');

  await post('/api/caos', { tasaFallo: 0, caido: false, latenciaExtraMs: 0 });

  const resultados = [];

  console.log('  [1/4] Lectura del catalogo (ruta cacheada)...');
  resultados.push(await medir('catalogo-cacheado', () => get('/api/eventos')));

  console.log('  [2/4] Agregacion BFF (3 llamadas internas en paralelo)...');
  resultados.push(await medir('bff-agregacion', () => get('/api/bff/evento/EVT-002')));

  console.log('  [3/4] Escritura: compra completa (saga de 4 pasos)...');
  resultados.push(await medir('compra-saga', () => post('/api/reservas', {
    eventoId: 'EVT-002', localidad: 'GEN', cantidad: 1, cliente: 'carga',
  }), { concurrencia: Math.min(CONCURRENCIA, 12) }));

  console.log('  [4/4] Compra con 30% de fallos en la pasarela (resiliencia bajo carga)...');
  await post('/api/caos', { tasaFallo: 0.3 });
  resultados.push(await medir('compra-con-caos', () => post('/api/reservas', {
    eventoId: 'EVT-002', localidad: 'GEN', cantidad: 1, cliente: 'carga-caos',
  }), { concurrencia: Math.min(CONCURRENCIA, 12) }));
  await post('/api/caos', { tasaFallo: 0 });

  console.log('\n  RESULTADOS (latencias en milisegundos)\n');
  imprimirTabla(resultados);

  const panel = await fetch(`${BASE}/api/panel`, { headers: { 'x-api-key': CLAVE } }).then((r) => r.json());
  const cache = panel.catalogo?.cache ?? {};
  const m = panel.reservas?.metricas ?? {};
  const inventario = await fetch(`${BASE}/api/bff/evento/EVT-002`, { headers: { 'x-api-key': CLAVE } })
    .then((r) => r.json());
  const negativas = (inventario.localidades ?? []).filter((l) => l.disponibles < 0).length;

  console.log('\n  ESTADO FINAL DE LA MALLA');
  console.log(`  - Tasa de aciertos de cache            : ${((cache.tasaAciertos ?? 0) * 100).toFixed(1)}%`);
  console.log(`  - Sagas completadas                    : ${m.sagasCompletadas}`);
  console.log(`  - Sagas compensadas                    : ${m.sagasCompensadas}`);
  console.log(`  - Conflictos de concurrencia resueltos : ${m.conflictosDeConcurrencia}`);
  console.log(`  - Localidades con inventario negativo  : ${negativas} (debe ser 0)\n`);

  console.log('  Nota: son cifras de un prototipo en una sola maquina, sin red real ni');
  console.log('  base de datos. Sirven para comparar escenarios entre si, no como');
  console.log('  capacidad de produccion.\n');

  apagarMalla();
}

main().catch((error) => {
  console.error('\n  Fallo la prueba de carga:', error.message, '\n');
  apagarMalla();
  process.exit(1);
});
