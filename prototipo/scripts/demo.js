/**
 * Recorrido guiado por los patrones implementados.
 *
 * Es el guion tecnico de la demostracion en video: cada bloque imprime que
 * patron esta ejercitando, la evidencia y el resultado. Ejecutar con la malla
 * levantada:  npm start   (en otra terminal)  ->  npm run demo
 */

import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.js';

const BASE = `http://127.0.0.1:${config.puertos.gateway}`;
const CLAVE_API = 'demo-armonia-2026';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const E = String.fromCharCode(27);
const c = {
  titulo: (t) => console.log(`\n${E}[1m${E}[36m${'='.repeat(72)}\n  ${t}\n${'='.repeat(72)}${E}[0m`),
  paso: (t) => console.log(`\n${E}[1m> ${t}${E}[0m`),
  ok: (t) => console.log(`  ${E}[32m[OK]${E}[0m ${t}`),
  info: (t) => console.log(`  ${E}[90m|${E}[0m   ${t}`),
  aviso: (t) => console.log(`  ${E}[33m[!]${E}[0m ${t}`),
  malo: (t) => console.log(`  ${E}[31m[X]${E}[0m ${t}`),
};

async function llamar(metodo, ruta, cuerpo, cabeceras = {}) {
  const inicio = Date.now();
  const respuesta = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-api-key': CLAVE_API, ...cabeceras },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await respuesta.text();
  return {
    estado: respuesta.status,
    ms: Date.now() - inicio,
    datos: texto ? JSON.parse(texto) : {},
  };
}

const pesos = (n) => '$' + Number(n).toLocaleString('es-CO') + ' COP';

/* ==================================================================== */

async function main() {
  c.titulo('ARMONIA S.A.S. - demostracion de la arquitectura');

  /* ---------------------------------------------------------------- */
  c.paso('0. Health Endpoint Monitoring: estado de la malla');
  const salud = await llamar('GET', '/api/salud');
  c.ok(`Estado general: ${salud.datos.estadoGeneral} (${salud.datos.saludables}/${salud.datos.total} servicios listos)`);
  for (const s of salud.datos.servicios) c.info(`${s.servicio.padEnd(16)} ${s.estado.padEnd(10)} ${s.latenciaMs} ms`);
  if (salud.datos.saludables < salud.datos.total) {
    c.malo('La malla no esta completa. Ejecute "npm start" en otra terminal y reintente.');
    process.exit(1);
  }

  // Se apaga el caos para que el camino feliz sea determinista.
  await llamar('POST', '/api/caos', { tasaFallo: 0, caido: false, latenciaExtraMs: 0 });

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 1 - Cache-Aside');
  c.paso('1.1 Primera consulta al catalogo (cache vacia -> va a la base de datos)');
  const fria = await llamar('GET', '/api/eventos');
  c.ok(`${fria.datos.total} eventos | origen: ${fria.datos.origen} | ${fria.ms} ms`);

  c.paso('1.2 Segunda consulta identica (deberia resolverse en cache)');
  const caliente = await llamar('GET', '/api/eventos');
  c.ok(`origen: ${caliente.datos.origen} | ${caliente.ms} ms`);
  const mejora = fria.ms > 0 ? Math.round(((fria.ms - caliente.ms) / fria.ms) * 100) : 0;
  c.info(`Reduccion de latencia: ${mejora}% (${fria.ms} ms -> ${caliente.ms} ms)`);

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 2 - Gateway Aggregation / Backend for Frontend');
  c.paso('2.1 Una sola llamada del cliente movil resuelve tres consultas internas');
  const bff = await llamar('GET', '/api/bff/evento/EVT-002');
  c.ok(`${bff.datos.evento.nombre} - ${bff.datos.evento.ciudad} (${bff.ms} ms)`);
  c.info(`Llamadas de red ahorradas al cliente: ${bff.datos.llamadasAhorradasAlCliente}`);
  for (const l of bff.datos.localidades) {
    c.info(`${l.codigo.padEnd(4)} ${l.nombre.padEnd(14)} ${pesos(l.precioCOP).padEnd(16)} disponibles: ${l.disponibles}`);
  }

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 3 - Saga orquestada (camino feliz)');
  c.paso('3.1 Compra de 2 boletas VIP con tarifa de estudiante');
  const compra = await llamar('POST', '/api/reservas', {
    eventoId: 'EVT-002', localidad: 'VIP', cantidad: 2,
    cliente: 'juan.velez', tipoTarifa: 'estudiante', medioDePago: 'tarjeta',
  }, { 'idempotency-key': randomUUID() });

  if (compra.estado !== 201) {
    c.malo(`La compra fallo (${compra.estado}): ${JSON.stringify(compra.datos)}`);
  } else {
    const r = compra.datos;
    c.ok(`Reserva ${r.id} | estado ${r.estado} | ${compra.ms} ms`);
    c.info(`Tarifa "${r.tarifa.politica}": subtotal ${pesos(r.tarifa.subtotalCOP)} - descuento ${pesos(r.tarifa.descuentoCOP)} = ${pesos(r.totalCOP)}`);
    c.info('Pasos de la saga:');
    for (const p of r.pasos) c.info(`   ${p.paso.padEnd(18)} ${p.estado}`);
  }

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 4 - Idempotent Receiver');
  c.paso('4.1 El cliente pierde la conexion y reenvia la MISMA peticion');
  const clave = randomUUID();
  const primera = await llamar('POST', '/api/reservas', {
    eventoId: 'EVT-001', localidad: 'BAL', cantidad: 1, cliente: 'ana.gomez',
  }, { 'idempotency-key': clave });
  const repetida = await llamar('POST', '/api/reservas', {
    eventoId: 'EVT-001', localidad: 'BAL', cantidad: 1, cliente: 'ana.gomez',
  }, { 'idempotency-key': clave });

  c.ok(`1er envio -> HTTP ${primera.estado}, reserva ${primera.datos.id}`);
  c.ok(`2do envio -> HTTP ${repetida.estado}, reserva ${repetida.datos.id}`);
  if (primera.datos.id === repetida.datos.id && repetida.datos.reutilizadaPorIdempotencia) {
    c.ok('MISMA reserva devuelta: no se cobro dos veces ni se descontaron 2 boletas.');
  } else {
    c.malo('La idempotencia no funciono como se esperaba.');
  }

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 5 - Compensating Transaction (rollback de la saga)');
  c.paso('5.1 Se inyecta caos: la pasarela de pagos rechaza el 100% de los cobros');
  await llamar('POST', '/api/caos', { tasaFallo: 1 });

  const inventarioAntes = await llamar('GET', '/api/bff/evento/EVT-001');
  const balconAntes = inventarioAntes.datos.localidades.find((l) => l.codigo === 'BAL').disponibles;
  c.info(`Boletas disponibles en Balcon ANTES: ${balconAntes}`);

  const fallida = await llamar('POST', '/api/reservas', {
    eventoId: 'EVT-001', localidad: 'BAL', cantidad: 3, cliente: 'pedro.ruiz',
  }, { 'idempotency-key': randomUUID() });
  c.aviso(`La compra fallo con HTTP ${fallida.estado}: ${fallida.datos.error}`);
  if (fallida.datos.detalle?.pasos) {
    for (const p of fallida.datos.detalle.pasos) c.info(`   ${p.paso.padEnd(18)} ${p.estado}`);
  }

  await dormir(200);
  const inventarioDespues = await llamar('GET', '/api/bff/evento/EVT-001');
  const balconDespues = inventarioDespues.datos.localidades.find((l) => l.codigo === 'BAL').disponibles;
  c.info(`Boletas disponibles en Balcon DESPUES: ${balconDespues}`);
  if (balconAntes === balconDespues) {
    c.ok('El cupo se devolvio integro: la transaccion compensatoria funciono.');
  } else {
    c.malo(`Se perdieron ${balconAntes - balconDespues} boletas: la compensacion fallo.`);
  }

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 6 - Circuit Breaker');
  c.paso('6.1 La pasarela cae por completo; se lanzan 8 compras seguidas');
  await llamar('POST', '/api/caos', { caido: true });

  for (let i = 1; i <= 8; i += 1) {
    const intento = await llamar('POST', '/api/reservas', {
      eventoId: 'EVT-001', localidad: 'GEN', cantidad: 1, cliente: `cliente-${i}`,
    }, { 'idempotency-key': randomUUID() });
    const causa = intento.datos.detalle?.causa ?? intento.datos.error ?? '';
    const cortado = causa.includes('Cortacircuitos ABIERTO');
    const etiqueta = cortado ? `${E}[31m[CORTADO]${E}[0m` : `${E}[33m[INTENTO]${E}[0m`;
    console.log(`  ${etiqueta} ` +
      `#${i} HTTP ${intento.estado} en ${String(intento.ms).padStart(5)} ms  ${causa.slice(0, 60)}`);
  }
  const panelCircuito = await llamar('GET', '/api/panel');
  const circuitoPagos = panelCircuito.datos.reservas?.dependencias?.find((d) => d.destino === 'pagos');
  const circuitoCompra = panelCircuito.datos.gateway?.circuitos?.find((d) => d.destino === 'reservas:compra');
  const circuitoLectura = panelCircuito.datos.gateway?.circuitos?.find((d) => d.destino === 'reservas');
  if (circuitoLectura) {
    c.info(`gateway -> reservas (lecturas): ${circuitoLectura.circuito.estado}  <- sigue operativo`);
  }
  if (circuitoCompra) {
    c.info(`gateway -> reservas:compra   : ${circuitoCompra.circuito.estado}  <- solo se corta la compra`);
  }
  if (circuitoPagos) {
    c.ok(`Estado del cortacircuitos hacia "pagos": ${circuitoPagos.circuito.estado}`);
    c.info(`aperturas: ${circuitoPagos.circuito.aperturas} | rechazos rapidos: ${circuitoPagos.circuito.rechazos}`);
    c.info('Observe como las ultimas peticiones tardan milisegundos en vez de segundos:');
    c.info('el sistema deja de esperar por un servicio que sabe que esta caido.');
  }

  c.paso('6.2 Se restablece la pasarela y se espera a que el circuito se reabra');
  await llamar('POST', '/api/caos', { caido: false, tasaFallo: 0 });
  let recuperado = false;
  for (let intento = 1; intento <= 4 && !recuperado; intento += 1) {
    await dormir(config.resiliencia.tiempoAperturaCircuitoMs + 400);
    const prueba = await llamar('POST', '/api/reservas', {
      eventoId: 'EVT-001', localidad: 'GEN', cantidad: 1, cliente: `recuperacion-${intento}`,
    }, { 'idempotency-key': randomUUID() });
    c.info(`intento de recuperacion ${intento}: HTTP ${prueba.estado}`);
    recuperado = prueba.estado === 201;
  }
  if (recuperado) {
    c.ok('El circuito paso a SEMIABIERTO, la peticion de prueba funciono y volvio a CERRADO.');
    c.info('Recuperacion automatica: nadie tuvo que reiniciar ningun servicio.');
  } else {
    c.aviso('El circuito sigue abierto; aumente TIEMPO_APERTURA_MS o revise la pasarela.');
  }

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 7 - Retry con espera exponencial');
  c.paso('7.1 Fallos intermitentes del 40%: el reintento los absorbe sin que el usuario los note');
  await llamar('POST', '/api/caos', { tasaFallo: 0.4 });
  let exitos = 0;
  for (let i = 0; i < 6; i += 1) {
    const intento = await llamar('POST', '/api/reservas', {
      eventoId: 'EVT-003', localidad: 'GEN', cantidad: 1, cliente: `intermitente-${i}`,
    }, { 'idempotency-key': randomUUID() });
    if (intento.estado === 201) exitos += 1;
  }
  c.ok(`${exitos}/6 compras completadas pese al 40% de fallos en la pasarela`);
  c.info('Sin el patron Retry el resultado esperado seria cercano a 3.6/6.');
  await llamar('POST', '/api/caos', { tasaFallo: 0 });

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 8 - Publisher/Subscriber + Competing Consumers + CQRS');
  c.paso('8.1 Bandeja de notificaciones generada de forma asincrona');
  await dormir(1200); // se da tiempo a los consumidores
  const bandeja = await llamar('GET', '/api/notificaciones?limite=5');
  c.ok(`${bandeja.datos.total} notificaciones despachadas`);
  for (const n of bandeja.datos.notificaciones.slice(0, 3)) {
    c.info(`${n.tipo.padEnd(20)} reserva ${n.reservaId ?? '-'} -> canales: ${n.envios.map((e) => e.canal).join(', ')}`);
  }

  c.paso('8.2 Reparto entre consumidores en competencia');
  const panel = await llamar('GET', '/api/panel');
  for (const t of panel.datos.notificaciones?.trabajadores ?? []) {
    c.info(`${t.trabajador}: ${t.procesados} mensajes procesados`);
  }

  c.paso('8.3 Vista materializada de CQRS actualizada por eventos');
  const proyeccion = panel.datos.catalogo?.proyeccionCQRS;
  if (proyeccion) c.info(`eventos de dominio aplicados a la proyeccion: ${proyeccion.eventosAplicados}`);
  const disponibilidad = await llamar('GET', '/api/bff/evento/EVT-002');
  c.info(`Consistencia de la vista de disponibilidad: eventual (se actualiza por eventos, no por consulta)`);
  for (const l of disponibilidad.datos.vistaEventual) {
    c.info(`${l.localidad.padEnd(4)} vendidas: ${String(l.vendidas).padStart(4)} | ocupacion: ${l.porcentajeOcupacion}%`);
  }

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 9 - Throttling (limitacion de tasa)');
  const TAMANO_RAFAGA = config.resiliencia.limitePeticionesPorMinuto + 60;
  c.paso(`9.1 Rafaga de ${TAMANO_RAFAGA} peticiones desde la misma clave de API`);
  // Se usa OTRA clave de API para no agotar la cuota de la propia demo:
  // el limitador es por clave, justamente para aislar a los inquilinos.
  const rafaga = await Promise.all(
    Array.from({ length: TAMANO_RAFAGA }, () =>
      llamar('GET', '/api/eventos', null, { 'x-api-key': 'panel-interno' })),
  );
  const limitadas = rafaga.filter((r) => r.estado === 429).length;
  c.ok(`${rafaga.length - limitadas} atendidas, ${limitadas} rechazadas con HTTP 429`);
  c.info(`Limite configurado: ${config.resiliencia.limitePeticionesPorMinuto} peticiones/minuto por clave.`);

  /* ---------------------------------------------------------------- */
  c.titulo('PATRON 10 - Concurrencia optimista (sin sobreventa)');
  c.paso('10.1 Localidad casi agotada: EVT-003 / Palco. 20 compradores simultaneos por 1 boleta');
  const antes = await llamar('GET', '/api/bff/evento/EVT-003');
  const palcoAntes = antes.datos.localidades?.find((l) => l.codigo === 'PAL')?.disponibles ?? 0;
  c.info(`Boletas realmente disponibles: ${palcoAntes}`);

  const compradores = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    llamar('POST', '/api/reservas', {
      eventoId: 'EVT-003', localidad: 'PAL', cantidad: 1, cliente: `pelea-${i}`,
    }, { 'idempotency-key': randomUUID() })));

  const ganadores = compradores.filter((r) => r.estado === 201).length;
  const sinCupo = compradores.filter((r) => r.estado === 409).length;
  c.ok(`Compras exitosas: ${ganadores} | rechazadas por falta de cupo: ${sinCupo}`);

  const despues = await llamar('GET', '/api/bff/evento/EVT-003');
  const palcoDespues = despues.datos.localidades?.find((l) => l.codigo === 'PAL')?.disponibles ?? 0;
  c.info(`Boletas disponibles al final: ${palcoDespues}`);
  if (ganadores <= palcoAntes && palcoDespues >= 0) {
    c.ok(`No hubo sobreventa: se vendieron ${ganadores} de ${palcoAntes} boletas disponibles.`);
    c.info('El bloqueo optimista con numero de version serializo a los 20 compradores.');
  } else {
    c.malo(`SOBREVENTA: se vendieron ${ganadores} boletas y solo habia ${palcoAntes}.`);
  }

  /* ---------------------------------------------------------------- */
  c.titulo('RESUMEN');
  const final = await llamar('GET', '/api/panel');
  const m = final.datos.reservas?.metricas ?? {};
  c.info(`Sagas iniciadas    : ${m.sagasIniciadas}`);
  c.info(`Sagas completadas  : ${m.sagasCompletadas}`);
  c.info(`Sagas compensadas  : ${m.sagasCompensadas}`);
  c.info(`Conflictos de concurrencia resueltos : ${m.conflictosDeConcurrencia}`);
  c.info(`Respuestas idempotentes              : ${m.respuestasIdempotentes}`);
  const cache = final.datos.catalogo?.cache ?? {};
  c.info(`Tasa de aciertos de cache            : ${(cache.tasaAciertos * 100).toFixed(1)}%`);
  console.log('\n  Demostracion finalizada.\n');
}

main().catch((error) => {
  console.error('\n  La demostracion fallo:', error.message);
  console.error('  Verifique que la malla este levantada con "npm start".\n');
  process.exit(1);
});
