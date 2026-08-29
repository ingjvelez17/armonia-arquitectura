/**
 * Pruebas de integracion extremo a extremo.
 *
 * Levantan la malla COMPLETA (seis procesos) en puertos alternos, ejercitan el
 * sistema a traves del API Gateway igual que lo haria un cliente real, y la
 * apagan al terminar. Verifican propiedades del SISTEMA que ninguna prueba
 * unitaria puede cubrir: que la saga compensa de verdad, que la idempotencia
 * atraviesa dos servicios y que la proyeccion CQRS termina convergiendo.
 *
 * Se usan puertos 91xx para no chocar con una malla que ya este corriendo.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = { gateway: 9180, catalogo: 9181, reservas: 9182, pagos: 9183, notificaciones: 9184, broker: 9185 };
const BASE = `http://127.0.0.1:${P.gateway}`;
const CLAVE = 'demo-armonia-2026';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTORNO = {
  ...process.env,
  LOG_LEVEL: 'error',
  PUERTO_GATEWAY: String(P.gateway),
  PUERTO_CATALOGO: String(P.catalogo),
  PUERTO_RESERVAS: String(P.reservas),
  PUERTO_PAGOS: String(P.pagos),
  PUERTO_NOTIFICACIONES: String(P.notificaciones),
  PUERTO_BROKER: String(P.broker),
  URL_CATALOGO: `http://127.0.0.1:${P.catalogo}`,
  URL_RESERVAS: `http://127.0.0.1:${P.reservas}`,
  URL_PAGOS: `http://127.0.0.1:${P.pagos}`,
  URL_NOTIFICACIONES: `http://127.0.0.1:${P.notificaciones}`,
  URL_BROKER: `http://127.0.0.1:${P.broker}`,
  TASA_FALLO_PAGOS: '0',       // camino feliz determinista salvo donde se inyecte caos
  TIEMPO_APERTURA_MS: '1500',  // el circuito se reabre rapido para no alargar la suite
  LIMITE_RPM: '5000',          // la limitacion de tasa se prueba aparte, no aqui
};

const SERVICIOS = [
  'services/broker/index.js',
  'services/catalogo/index.js',
  'services/pagos/index.js',
  'services/reservas/index.js',
  'services/notificaciones/index.js',
  'services/gateway/index.js',
];

const procesos = [];

async function api(metodo, ruta, cuerpo, cabeceras = {}) {
  const respuesta = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-api-key': CLAVE, ...cabeceras },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await respuesta.text();
  return { estado: respuesta.status, datos: texto ? JSON.parse(texto) : {} };
}

before(async () => {
  for (const relativa of SERVICIOS) {
    procesos.push(spawn(process.execPath, [path.join(RAIZ, relativa)], { env: ENTORNO, stdio: 'ignore' }));
    await dormir(200);
  }
  // Espera activa a que la malla este completa (hasta 20 s).
  for (let intento = 0; intento < 40; intento += 1) {
    try {
      const salud = await api('GET', '/api/salud');
      if (salud.datos.estadoGeneral === 'operativo') return;
    } catch { /* todavia no responde */ }
    await dormir(500);
  }
  throw new Error('La malla de prueba no llego a estar operativa');
});

after(() => { for (const p of procesos) p.kill('SIGTERM'); });

/* ==================================================================== */

test('la malla completa reporta estado operativo', async () => {
  const { datos } = await api('GET', '/api/salud');
  assert.equal(datos.estadoGeneral, 'operativo');
  assert.equal(datos.saludables, 5);
});

test('Gateway Offloading: sin API key una escritura se rechaza con 401', async () => {
  const respuesta = await fetch(`${BASE}/api/reservas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventoId: 'EVT-001', localidad: 'GEN', cantidad: 1, cliente: 'x' }),
  });
  assert.equal(respuesta.status, 401);
});

test('Gateway Aggregation: una llamada devuelve datos de dos servicios fusionados', async () => {
  const { estado, datos } = await api('GET', '/api/bff/evento/EVT-002');
  assert.equal(estado, 200);
  assert.equal(datos.evento.id, 'EVT-002');
  assert.ok(datos.localidades.length >= 3);
  // El precio viene de catalogo y la disponibilidad del inventario de reservas.
  for (const localidad of datos.localidades) {
    assert.equal(typeof localidad.precioCOP, 'number');
    assert.equal(typeof localidad.disponibles, 'number');
  }
});

test('Cache-Aside: la segunda consulta se resuelve en cache', async () => {
  await api('GET', '/api/eventos');
  const { datos } = await api('GET', '/api/eventos');
  assert.equal(datos.origen, 'cache');
});

test('Saga: el camino feliz confirma la reserva y descuenta el inventario', async () => {
  const antes = await api('GET', '/api/bff/evento/EVT-001');
  const disponiblesAntes = antes.datos.localidades.find((l) => l.codigo === 'PLA').disponibles;

  const { estado, datos } = await api('POST', '/api/reservas', {
    eventoId: 'EVT-001', localidad: 'PLA', cantidad: 2, cliente: 'prueba.integracion',
  }, { 'idempotency-key': randomUUID() });

  assert.equal(estado, 201);
  assert.equal(datos.estado, 'CONFIRMADA');
  assert.ok(datos.transaccionId, 'debe quedar registrada la transaccion de pago');
  assert.deepEqual(datos.pasos.map((p) => p.paso),
    ['reservar-cupo', 'calcular-tarifa', 'cobrar', 'confirmar']);

  const despues = await api('GET', '/api/bff/evento/EVT-001');
  const disponiblesDespues = despues.datos.localidades.find((l) => l.codigo === 'PLA').disponibles;
  assert.equal(disponiblesDespues, disponiblesAntes - 2);
});

test('Strategy: la tarifa de estudiante aplica el 30% de descuento extremo a extremo', async () => {
  const { datos } = await api('POST', '/api/reservas', {
    eventoId: 'EVT-001', localidad: 'BAL', cantidad: 1,
    cliente: 'estudiante.prueba', tipoTarifa: 'estudiante',
  }, { 'idempotency-key': randomUUID() });

  assert.equal(datos.tarifa.politica, 'estudiante');
  assert.equal(datos.tarifa.descuentoCOP, Math.round(datos.tarifa.subtotalCOP * 0.3));
  assert.equal(datos.totalCOP, datos.tarifa.subtotalCOP - datos.tarifa.descuentoCOP);
});

test('Idempotencia: reenviar la misma clave no genera una segunda compra', async () => {
  const clave = randomUUID();
  const cuerpo = { eventoId: 'EVT-001', localidad: 'GEN', cantidad: 1, cliente: 'idempotente' };

  const primera = await api('POST', '/api/reservas', cuerpo, { 'idempotency-key': clave });
  const segunda = await api('POST', '/api/reservas', cuerpo, { 'idempotency-key': clave });

  assert.equal(primera.estado, 201);
  assert.equal(segunda.estado, 200);
  assert.equal(segunda.datos.id, primera.datos.id);
  assert.equal(segunda.datos.reutilizadaPorIdempotencia, true);
});

test('Validacion: los datos invalidos se rechazan con 400 antes de tocar el dominio', async () => {
  const { estado, datos } = await api('POST', '/api/reservas',
    { eventoId: 'EVT-001', localidad: 'GEN', cantidad: 99, cliente: 'abusivo' },
    { 'idempotency-key': randomUUID() });
  assert.equal(estado, 400);
  assert.ok(Array.isArray(datos.detalle));
});

test('Compensacion: si el pago falla, el cupo vuelve al inventario', async () => {
  await api('POST', '/api/caos', { tasaFallo: 1 });

  const antes = await api('GET', '/api/bff/evento/EVT-002');
  const disponiblesAntes = antes.datos.localidades.find((l) => l.codigo === 'PRE').disponibles;

  const compra = await api('POST', '/api/reservas', {
    eventoId: 'EVT-002', localidad: 'PRE', cantidad: 4, cliente: 'compensacion',
  }, { 'idempotency-key': randomUUID() });

  assert.ok(compra.estado >= 400, 'la compra debia fallar');
  assert.ok(compra.datos.detalle.pasos.some((p) => p.paso === 'compensar'));

  await dormir(300);
  const despues = await api('GET', '/api/bff/evento/EVT-002');
  const disponiblesDespues = despues.datos.localidades.find((l) => l.codigo === 'PRE').disponibles;
  assert.equal(disponiblesDespues, disponiblesAntes, 'no se pueden perder boletas por un pago fallido');

  await api('POST', '/api/caos', { tasaFallo: 0 });
});

test('Circuit Breaker: tras varios fallos el sistema falla rapido y luego se recupera solo', async () => {
  await api('POST', '/api/caos', { caido: true });

  const tiempos = [];
  for (let i = 0; i < 8; i += 1) {
    const inicio = Date.now();
    await api('POST', '/api/reservas',
      { eventoId: 'EVT-001', localidad: 'GEN', cantidad: 1, cliente: `cb-${i}` },
      { 'idempotency-key': randomUUID() });
    tiempos.push(Date.now() - inicio);
  }

  const ultimo = tiempos[tiempos.length - 1];
  assert.ok(ultimo < 120,
    `con el circuito abierto la respuesta debe ser inmediata; tardo ${ultimo} ms`);

  // Recuperacion automatica
  await api('POST', '/api/caos', { caido: false, tasaFallo: 0 });
  let recuperado = false;
  for (let intento = 0; intento < 6 && !recuperado; intento += 1) {
    await dormir(1800);
    const prueba = await api('POST', '/api/reservas',
      { eventoId: 'EVT-001', localidad: 'GEN', cantidad: 1, cliente: `recup-${intento}` },
      { 'idempotency-key': randomUUID() });
    recuperado = prueba.estado === 201;
  }
  assert.ok(recuperado, 'el circuito debe volver a CERRADO sin intervencion humana');
});

test('Retry: con 40% de fallos transitorios la mayoria de compras completa', async () => {
  await api('POST', '/api/caos', { tasaFallo: 0.4 });

  let exitos = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await api('POST', '/api/reservas',
      { eventoId: 'EVT-002', localidad: 'GEN', cantidad: 1, cliente: `retry-${i}` },
      { 'idempotency-key': randomUUID() });
    if (r.estado === 201) exitos += 1;
  }
  await api('POST', '/api/caos', { tasaFallo: 0 });

  assert.ok(exitos >= 8,
    `con 3 reintentos se espera >=8/10 exitos; se obtuvieron ${exitos}`);
});

test('Concurrencia optimista: 15 compradores simultaneos no provocan sobreventa', async () => {
  const antes = await api('GET', '/api/bff/evento/EVT-003');
  const disponibles = antes.datos.localidades.find((l) => l.codigo === 'PAL').disponibles;

  const resultados = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    api('POST', '/api/reservas',
      { eventoId: 'EVT-003', localidad: 'PAL', cantidad: 1, cliente: `carrera-${i}` },
      { 'idempotency-key': randomUUID() })));

  const vendidas = resultados.filter((r) => r.estado === 201).length;
  assert.equal(vendidas, disponibles,
    `habia ${disponibles} boletas y se vendieron ${vendidas}`);

  const despues = await api('GET', '/api/bff/evento/EVT-003');
  const restantes = despues.datos.localidades.find((l) => l.codigo === 'PAL').disponibles;
  assert.equal(restantes, 0);
  assert.ok(restantes >= 0, 'el inventario nunca puede quedar negativo');
});

test('Pub/Sub asincrono: cada compra confirmada genera notificaciones por varios canales', async () => {
  const compra = await api('POST', '/api/reservas',
    { eventoId: 'EVT-001', localidad: 'BAL', cantidad: 1, cliente: 'notificado' },
    { 'idempotency-key': randomUUID() });
  assert.equal(compra.estado, 201);

  let encontrada = null;
  for (let intento = 0; intento < 20 && !encontrada; intento += 1) {
    await dormir(300);
    const bandeja = await api('GET', '/api/notificaciones?limite=100');
    encontrada = (bandeja.datos.notificaciones ?? []).find(
      (n) => n.reservaId === compra.datos.id && n.tipo === 'reserva.confirmada');
  }

  assert.ok(encontrada, 'debe llegar la notificacion de reserva confirmada');
  const canales = encontrada.envios.map((e) => e.canal);
  assert.ok(canales.includes('correo'));
  assert.ok(canales.includes('sms'));
});

test('CQRS: la vista materializada converge con el almacen autoritativo', async () => {
  let convergio = false;
  for (let intento = 0; intento < 20 && !convergio; intento += 1) {
    await dormir(400);
    const { datos } = await api('GET', '/api/bff/evento/EVT-001');
    const autoritativo = datos.localidades.find((l) => l.codigo === 'PLA');
    const proyeccion = datos.vistaEventual.find((l) => l.localidad === 'PLA');
    convergio = proyeccion && autoritativo.vendidas === proyeccion.vendidas;
  }
  assert.ok(convergio,
    'la proyeccion eventual debe alcanzar al almacen autoritativo en pocos segundos');
});

test('Reembolso: la transaccion compensatoria posterior devuelve el dinero y el cupo', async () => {
  const compra = await api('POST', '/api/reservas',
    { eventoId: 'EVT-002', localidad: 'VIP', cantidad: 2, cliente: 'arrepentido' },
    { 'idempotency-key': randomUUID() });
  assert.equal(compra.estado, 201);

  const antes = await api('GET', '/api/bff/evento/EVT-002');
  const disponiblesAntes = antes.datos.localidades.find((l) => l.codigo === 'VIP').disponibles;

  const reembolso = await api('POST', `/api/reservas/${compra.datos.id}/reembolso`,
    { motivo: 'el cliente cambio de planes' });
  assert.equal(reembolso.estado, 200);
  assert.equal(reembolso.datos.estado, 'REEMBOLSADA');

  const despues = await api('GET', '/api/bff/evento/EVT-002');
  const disponiblesDespues = despues.datos.localidades.find((l) => l.codigo === 'VIP').disponibles;
  assert.equal(disponiblesDespues, disponiblesAntes + 2, 'las boletas vuelven a estar a la venta');
});

test('Trazabilidad: el correlation id del cliente se propaga por toda la cadena', async () => {
  const cid = randomUUID();
  const respuesta = await fetch(`${BASE}/api/bff/evento/EVT-001`, {
    headers: { 'x-api-key': CLAVE, 'x-correlation-id': cid },
  });
  assert.equal(respuesta.headers.get('x-correlation-id'), cid);
});

test('Degradacion elegante: el panel de observabilidad responde aunque haya servicios rotos', async () => {
  await api('POST', '/api/caos', { caido: true });
  const panel = await api('GET', '/api/panel');
  assert.equal(panel.estado, 200);
  assert.ok(panel.datos.catalogo, 'el diagnostico del catalogo debe seguir llegando');
  await api('POST', '/api/caos', { caido: false });
});
