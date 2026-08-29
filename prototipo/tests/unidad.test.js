/**
 * Pruebas unitarias de los componentes de arquitectura.
 *
 * Se ejecutan con el corredor nativo de Node (`node --test`), sin frameworks
 * externos. Cada bloque verifica la PROPIEDAD que justifica el patron, no su
 * implementacion: si manana se cambia el algoritmo interno del cortacircuitos,
 * estas pruebas deben seguir pasando mientras se conserve el comportamiento.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  conReintentos, Cortacircuitos, ESTADOS_CIRCUITO, Mamparo,
  LimitadorDeTasa, conTiempoLimite, dormir, CortacircuitosAbiertoError,
} from '../lib/resiliencia.js';
import { CacheEnMemoria } from '../lib/cache.js';
import { RepositorioEnMemoria, ConflictoDeConcurrenciaError } from '../lib/repositorio.js';
import { obtenerEstrategia, TIPOS_DE_TARIFA } from '../services/reservas/tarifas.js';
import { obtenerAdaptador, MEDIOS_DE_PAGO } from '../services/pagos/pasarelas.js';

/* ==================================================================== */
test('Retry: reintenta los fallos transitorios y termina teniendo exito', async () => {
  let intentos = 0;
  const resultado = await conReintentos(async () => {
    intentos += 1;
    if (intentos < 3) throw new Error('fallo transitorio');
    return 'listo';
  }, { intentosMaximos: 5, esperaBaseMs: 1 });

  assert.equal(resultado, 'listo');
  assert.equal(intentos, 3, 'debio necesitar exactamente 3 intentos');
});

test('Retry: NO reintenta un error de negocio (no transitorio)', async () => {
  let intentos = 0;
  await assert.rejects(
    () => conReintentos(async () => {
      intentos += 1;
      const error = new Error('cupo insuficiente');
      error.estado = 409;
      throw error;
    }, { intentosMaximos: 5, esperaBaseMs: 1, esTransitorio: (e) => e.estado >= 500 }),
    /cupo insuficiente/,
  );
  assert.equal(intentos, 1, 'un 409 jamas debe reintentarse');
});

test('Retry: la espera crece de forma exponencial', async () => {
  const esperas = [];
  await conReintentos(async (i) => {
    if (i < 4) throw new Error('x');
    return 'ok';
  }, {
    intentosMaximos: 4, esperaBaseMs: 10,
    alReintentar: ({ espera }) => esperas.push(espera),
  });
  assert.equal(esperas.length, 3);
  assert.ok(esperas[1] > esperas[0], 'la segunda espera debe superar a la primera');
  assert.ok(esperas[2] > esperas[1], 'la tercera espera debe superar a la segunda');
});

/* ==================================================================== */
test('Circuit Breaker: se abre tras N fallos consecutivos', async () => {
  const cb = new Cortacircuitos('destino', { umbralFallos: 3, tiempoAperturaMs: 50 });
  const fallar = () => Promise.reject(new Error('caido'));

  for (let i = 0; i < 3; i += 1) await assert.rejects(() => cb.ejecutar(fallar));
  assert.equal(cb.estado, ESTADOS_CIRCUITO.ABIERTO);
});

test('Circuit Breaker: estando ABIERTO falla rapido sin llamar al destino', async () => {
  const cb = new Cortacircuitos('destino', { umbralFallos: 1, tiempoAperturaMs: 5000 });
  await assert.rejects(() => cb.ejecutar(() => Promise.reject(new Error('caido'))));

  let vecesLlamado = 0;
  await assert.rejects(
    () => cb.ejecutar(async () => { vecesLlamado += 1; return 'ok'; }),
    CortacircuitosAbiertoError,
  );
  assert.equal(vecesLlamado, 0, 'no debe tocar al destino con el circuito abierto');
});

test('Circuit Breaker: pasa a SEMIABIERTO y se recupera solo', async () => {
  const cb = new Cortacircuitos('destino', { umbralFallos: 1, tiempoAperturaMs: 40 });
  await assert.rejects(() => cb.ejecutar(() => Promise.reject(new Error('caido'))));
  assert.equal(cb.estado, ESTADOS_CIRCUITO.ABIERTO);

  await dormir(60);
  const resultado = await cb.ejecutar(async () => 'recuperado');
  assert.equal(resultado, 'recuperado');
  assert.equal(cb.estado, ESTADOS_CIRCUITO.CERRADO);
});

test('Circuit Breaker: un rechazo de NEGOCIO no ensucia el circuito', async () => {
  const cb = new Cortacircuitos('destino', { umbralFallos: 2, tiempoAperturaMs: 500 });
  const esInfraestructura = (e) => e.estado >= 500;
  const errorDeNegocio = () => {
    const e = new Error('sin cupo'); e.estado = 409; return Promise.reject(e);
  };

  for (let i = 0; i < 5; i += 1) await assert.rejects(() => cb.ejecutar(errorDeNegocio, null, esInfraestructura));
  assert.equal(cb.estado, ESTADOS_CIRCUITO.CERRADO,
    'el servicio esta sano: solo dice que no hay cupo');
});

test('Circuit Breaker: con respaldo se degrada en vez de fallar', async () => {
  const cb = new Cortacircuitos('destino', { umbralFallos: 1, tiempoAperturaMs: 5000 });
  await cb.ejecutar(() => Promise.reject(new Error('caido')), () => 'respaldo');
  const valor = await cb.ejecutar(() => Promise.reject(new Error('caido')), () => 'respaldo');
  assert.equal(valor, 'respaldo');
});

/* ==================================================================== */
test('Bulkhead: nunca supera la concurrencia maxima', async () => {
  const mamparo = new Mamparo('destino', 3, 50);
  let simultaneas = 0, pico = 0;

  await Promise.all(Array.from({ length: 15 }, () => mamparo.ejecutar(async () => {
    simultaneas += 1;
    pico = Math.max(pico, simultaneas);
    await dormir(10);
    simultaneas -= 1;
  })));

  assert.ok(pico <= 3, `el pico de concurrencia fue ${pico}, deberia ser <= 3`);
});

/* ==================================================================== */
test('Throttling: rechaza al superar la capacidad de la ventana', () => {
  const limitador = new LimitadorDeTasa(5, 60_000);
  const veredictos = Array.from({ length: 8 }, () => limitador.permitir('cliente-a'));
  assert.equal(veredictos.filter((v) => v.permitido).length, 5);
  assert.equal(veredictos.filter((v) => !v.permitido).length, 3);
});

test('Throttling: la cuota es independiente por cliente (aislamiento)', () => {
  const limitador = new LimitadorDeTasa(2, 60_000);
  limitador.permitir('cliente-a');
  limitador.permitir('cliente-a');
  assert.equal(limitador.permitir('cliente-a').permitido, false);
  assert.equal(limitador.permitir('cliente-b').permitido, true,
    'un cliente abusivo no puede consumir la cuota de otro');
});

/* ==================================================================== */
test('Timeout: aborta una operacion que nunca responde', async () => {
  await assert.rejects(
    () => conTiempoLimite(new Promise(() => {}), 30),
    /Tiempo de espera agotado/,
  );
});

/* ==================================================================== */
test('Cache-Aside: el segundo acceso no vuelve al origen', async () => {
  const cache = new CacheEnMemoria({ ttlSegundos: 60 });
  let lecturasAlOrigen = 0;
  const origen = async () => { lecturasAlOrigen += 1; return { dato: 42 }; };

  const primero = await cache.resolver('k', origen);
  const segundo = await cache.resolver('k', origen);

  assert.equal(primero.desdeCache, false);
  assert.equal(segundo.desdeCache, true);
  assert.equal(lecturasAlOrigen, 1);
});

test('Cache-Aside: N peticiones simultaneas producen UNA sola lectura (anti-estampida)', async () => {
  const cache = new CacheEnMemoria({ ttlSegundos: 60 });
  let lecturas = 0;
  const origen = async () => { lecturas += 1; await dormir(30); return 'valor'; };

  await Promise.all(Array.from({ length: 25 }, () => cache.resolver('popular', origen)));
  assert.equal(lecturas, 1, 'la estampida de cache debe coalescerse en una sola lectura');
});

test('Cache-Aside: la invalidacion obliga a releer el origen', async () => {
  const cache = new CacheEnMemoria({ ttlSegundos: 60 });
  let lecturas = 0;
  const origen = async () => { lecturas += 1; return lecturas; };

  await cache.resolver('k', origen);
  cache.invalidar('k');
  await cache.resolver('k', origen);
  assert.equal(lecturas, 2);
});

test('Cache-Aside: la entrada caduca al vencer el TTL', async () => {
  const cache = new CacheEnMemoria({ ttlSegundos: 0.05 });
  let lecturas = 0;
  const origen = async () => { lecturas += 1; return 'v'; };

  await cache.resolver('k', origen);
  await dormir(80);
  await cache.resolver('k', origen);
  assert.equal(lecturas, 2);
});

/* ==================================================================== */
test('Repository: concurrencia optimista detecta la escritura perdida', async () => {
  const repo = new RepositorioEnMemoria('inv');
  await repo.guardar({ id: 'A', cantidad: 10 });

  const lecturaUsuario1 = await repo.buscarPorId('A');
  const lecturaUsuario2 = await repo.buscarPorId('A');

  lecturaUsuario1.cantidad = 9;
  await repo.guardarConVersion(lecturaUsuario1, lecturaUsuario1.version);

  lecturaUsuario2.cantidad = 8;
  await assert.rejects(
    () => repo.guardarConVersion(lecturaUsuario2, lecturaUsuario2.version),
    ConflictoDeConcurrenciaError,
    'la segunda escritura debe rechazarse: se baso en un dato ya obsoleto',
  );

  const actual = await repo.buscarPorId('A');
  assert.equal(actual.cantidad, 9, 'no se perdio la primera actualizacion');
});

test('Repository: 30 compradores concurrentes no provocan sobreventa', async () => {
  const repo = new RepositorioEnMemoria('inv');
  await repo.guardar({ id: 'LOC', capacidad: 5, vendidas: 0 });

  const comprar = async () => conReintentos(async () => {
    const fila = await repo.buscarPorId('LOC');
    if (fila.capacidad - fila.vendidas < 1) throw Object.assign(new Error('sin cupo'), { negocio: true });
    fila.vendidas += 1;
    await repo.guardarConVersion(fila, fila.version);
    return true;
  }, {
    intentosMaximos: 40, esperaBaseMs: 1,
    esTransitorio: (e) => e instanceof ConflictoDeConcurrenciaError,
  });

  const resultados = await Promise.allSettled(Array.from({ length: 30 }, comprar));
  const vendidas = resultados.filter((r) => r.status === 'fulfilled').length;
  const fila = await repo.buscarPorId('LOC');

  assert.equal(vendidas, 5, `se vendieron ${vendidas} boletas de 5 disponibles`);
  assert.equal(fila.vendidas, 5);
});

/* ==================================================================== */
test('Strategy: cada politica de tarifa aplica su propia regla', () => {
  const contexto = { precioBaseCOP: 100_000, cantidad: 2, porcentajeOcupacion: 0 };

  assert.equal(obtenerEstrategia('general').calcular(contexto).totalCOP, 200_000);
  assert.equal(obtenerEstrategia('estudiante').calcular(contexto).totalCOP, 140_000);
  assert.equal(obtenerEstrategia('club').calcular(contexto).totalCOP, 170_000);
});

test('Strategy: la tarifa dinamica recarga solo con alta ocupacion', () => {
  const dinamica = obtenerEstrategia('dinamica');
  const baja = dinamica.calcular({ precioBaseCOP: 100_000, cantidad: 1, porcentajeOcupacion: 40 });
  const alta = dinamica.calcular({ precioBaseCOP: 100_000, cantidad: 1, porcentajeOcupacion: 95 });

  assert.equal(baja.recargoCOP, 0);
  assert.ok(alta.recargoCOP > 0, 'con 95% de ocupacion debe haber recargo');
  assert.ok(alta.totalCOP > baja.totalCOP);
});

test('Strategy: una politica desconocida degrada a la tarifa general, no falla', () => {
  const estrategia = obtenerEstrategia('promocion-inexistente');
  assert.equal(estrategia.nombre, 'general');
  assert.ok(TIPOS_DE_TARIFA.includes('general'));
});

/* ==================================================================== */
test('Adapter: las tres pasarelas exponen la MISMA interfaz de salida', async () => {
  for (const medio of MEDIOS_DE_PAGO) {
    const adaptador = obtenerAdaptador(medio);
    const resultado = await adaptador.autorizar({ montoCOP: 50_000, cliente: 'prueba' });

    assert.equal(typeof resultado.aprobado, 'boolean', `${medio}: falta "aprobado"`);
    assert.equal(resultado.pasarela, medio);
    assert.ok('codigoAutorizacion' in resultado, `${medio}: falta "codigoAutorizacion"`);
  }
});

test('Adapter: traduce el rechazo propio de cada proveedor al formato interno', async () => {
  // PSE rechaza por cupo diario: su codigoRespuesta 1 debe llegar como aprobado:false.
  const pse = obtenerAdaptador('pse');
  const rechazo = await pse.autorizar({ montoCOP: 25_000_000, cliente: 'prueba' });
  assert.equal(rechazo.aprobado, false);
  assert.equal(rechazo.motivoRechazo, 'SUPERA_CUPO_DIARIO');
});

test('Adapter: un medio de pago no soportado se rechaza con 400, no con 500', () => {
  assert.throws(() => obtenerAdaptador('criptomoneda'), (e) => e.estado === 400);
});
