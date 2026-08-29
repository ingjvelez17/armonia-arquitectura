/**
 * ============================================================================
 *  SERVICIO DE RESERVAS  (puerto 8082)  -  nucleo transaccional
 * ============================================================================
 *
 * Es el corazon del sistema y donde se concentran los patrones criticos:
 *
 *   - Saga (orquestada)          : la compra cruza dos servicios (reservas y
 *                                  pagos) y no puede usarse una transaccion
 *                                  ACID distribuida. Se divide en pasos con
 *                                  compensacion explicita.
 *   - Compensating Transaction   : si el pago falla, se libera el cupo.
 *   - Idempotent Receiver        : la misma Idempotency-Key nunca cobra dos veces.
 *   - Optimistic Offline Lock    : dos compradores no pueden vender la misma silla.
 *   - Strategy                   : politicas de tarifa intercambiables.
 *   - Ambassador                 : toda llamada saliente lleva retry + cortacircuitos.
 *   - Publisher-Subscriber       : publica eventos de dominio; no llama a nadie mas.
 *   - Scheduler Agent Supervisor : un barredor expira reservas que quedaron colgadas.
 */

import { randomUUID } from 'node:crypto';
import { crearServidor, ErrorHttp, conEstado, CABECERA_IDEMPOTENCIA } from '../../lib/http.js';
import { config } from '../../lib/config.js';
import { crearLogger } from '../../lib/logger.js';
import { RepositorioEnMemoria, ConflictoDeConcurrenciaError } from '../../lib/repositorio.js';
import { ClienteServicio } from '../../lib/cliente-servicio.js';
import { Publicador } from '../../lib/bus.js';
import { conReintentos, ESPERAS } from '../../lib/resiliencia.js';
import { obtenerEstrategia, TIPOS_DE_TARIFA } from './tarifas.js';
import { INVENTARIO_SEMILLA, INVENTARIO_ESCASO } from './inventario.js';

const log = crearLogger('reservas');

/**
 * Latencia simulada de cada almacen. El inventario es una tabla OLTP
 * "caliente" con indice primario: 5 ms es realista. Cuanto mas corta sea la
 * operacion, mas estrecha es la ventana de conflicto del bloqueo optimista,
 * y por eso el inventario NO puede vivir en el mismo almacen lento que el
 * catalogo (180 ms). Es una decision de arquitectura, no un detalle.
 */
const repositorioInventario = new RepositorioEnMemoria('inventario', 5).sembrar(INVENTARIO_SEMILLA);
repositorioInventario.sembrar([INVENTARIO_ESCASO]);
const repositorioReservas = new RepositorioEnMemoria('reservas', 10);

const clienteCatalogo = new ClienteServicio('catalogo', config.servicios.catalogo, log);
const clientePagos = new ClienteServicio('pagos', config.servicios.pagos, log);
const publicador = new Publicador(log);

/** Idempotent Receiver: clave de idempotencia -> respuesta ya calculada. */
const registroIdempotencia = new Map();

const ESTADOS = Object.freeze({
  PENDIENTE: 'PENDIENTE',
  CONFIRMADA: 'CONFIRMADA',
  CANCELADA: 'CANCELADA',
  EXPIRADA: 'EXPIRADA',
  REEMBOLSADA: 'REEMBOLSADA',
});

const metricas = {
  sagasIniciadas: 0,
  sagasCompletadas: 0,
  sagasCompensadas: 0,
  conflictosDeConcurrencia: 0,
  respuestasIdempotentes: 0,
  reservasExpiradas: 0,
};

/* ==================================================================== */
/* Pasos de la saga                                                      */
/* ==================================================================== */

/**
 * PASO 1 - Reservar cupo con bloqueo optimista.
 *
 * Se lee el inventario, se verifica el cupo y se guarda exigiendo que la
 * version no haya cambiado. Si otro comprador se adelanto, el almacen lanza
 * ConflictoDeConcurrenciaError y se reintenta el ciclo completo. Este bucle
 * es lo que impide el "overbooking" sin bloquear la fila en la base de datos.
 */
async function reservarCupo({ eventoId, localidad, cantidad, correlationId }) {
  return conReintentos(async () => {
    const clave = `${eventoId}:${localidad}`;
    const fila = await repositorioInventario.buscarPorId(clave);
    if (!fila) throw new ErrorHttp(404, `No existe la localidad "${localidad}" para el evento "${eventoId}"`);

    const disponibles = fila.capacidad - fila.vendidas - fila.reservadas;
    if (disponibles < cantidad) {
      throw new ErrorHttp(409, 'Cupo insuficiente en la localidad solicitada', {
        solicitadas: cantidad, disponibles,
      });
    }

    fila.reservadas += cantidad;
    const guardada = await repositorioInventario.guardarConVersion(fila, fila.version);
    return {
      disponiblesAntes: disponibles,
      porcentajeOcupacion: Number((((guardada.vendidas + guardada.reservadas) / guardada.capacidad) * 100).toFixed(1)),
    };
  }, {
    // 12 intentos con espera CORTA y aleatoria (no exponencial).
    // Bajo el pico de un "onsale" decenas de compradores pelean por la MISMA
    // fila de inventario. La prueba de carga mostro: 5 intentos -> 30% de
    // rechazos; 12 intentos con backoff exponencial -> 92% de error (las
    // esperas superaban el timeout del gateway); 12 intentos con jitter corto
    // -> practicamente 0%. Limitacion conocida: por encima de ~50 escritores
    // concurrentes sobre la misma fila hay que particionar el inventario en
    // bloques o serializar por cola (ver seccion 8 del informe).
    intentosMaximos: 12,
    esperaBaseMs: 4,
    calcularEspera: ESPERAS.jitterCorto,
    esTransitorio: (error) => error instanceof ConflictoDeConcurrenciaError,
    alReintentar: ({ intento }) => {
      metricas.conflictosDeConcurrencia += 1;
      log.debug('conflicto de concurrencia en el inventario, reintentando', { correlationId, intento });
    },
  });
}

/** COMPENSACION del paso 1 - devolver el cupo al inventario. */
async function liberarCupo({ eventoId, localidad, cantidad, vendida = false, correlationId }) {
  try {
    await conReintentos(async () => {
      const clave = `${eventoId}:${localidad}`;
      const fila = await repositorioInventario.buscarPorId(clave);
      if (!fila) return;
      if (vendida) fila.vendidas = Math.max(0, fila.vendidas - cantidad);
      else fila.reservadas = Math.max(0, fila.reservadas - cantidad);
      await repositorioInventario.guardarConVersion(fila, fila.version);
    }, {
      intentosMaximos: 12,
      esperaBaseMs: 4,
      calcularEspera: ESPERAS.jitterCorto,
      esTransitorio: (error) => error instanceof ConflictoDeConcurrenciaError,
    });
    log.info('cupo liberado (transaccion compensatoria)', { correlationId, eventoId, localidad, cantidad });
  } catch (error) {
    // Nunca se propaga: la compensacion es best-effort y se registra para
    // que el supervisor / equipo de operaciones la reprocese.
    log.error('FALLO LA COMPENSACION - requiere intervencion manual', {
      correlationId, eventoId, localidad, cantidad, causa: error.message,
    });
  }
}

/** PASO 2 - Consultar el precio base en el catalogo (llamada entre servicios). */
async function obtenerPrecioBase({ eventoId, localidad, correlationId }) {
  const { evento } = await clienteCatalogo.get(`/eventos/${eventoId}`, { correlationId });
  const definicion = evento.localidades.find((l) => l.codigo === localidad);
  if (!definicion) throw new ErrorHttp(400, `La localidad "${localidad}" no pertenece al evento`);
  return { precioBaseCOP: definicion.precioCOP, nombreLocalidad: definicion.nombre, nombreEvento: evento.nombre };
}

/** PASO 3 - Cobrar. Es el paso que puede fallar y disparar la compensacion. */
async function cobrar({ reservaId, cliente, totalCOP, medioDePago, correlationId }) {
  return clientePagos.post('/cobros', {
    referencia: reservaId,
    cliente,
    montoCOP: totalCOP,
    medioDePago,
  }, {
    correlationId,
    // La clave de idempotencia del cobro es la propia reserva: si el
    // ambassador reintenta por un timeout, la pasarela no cobra dos veces.
    cabeceras: { [CABECERA_IDEMPOTENCIA]: `cobro-${reservaId}` },
  });
}

/* ==================================================================== */
/* Orquestador de la saga                                                */
/* ==================================================================== */

async function ejecutarSagaDeCompra({ datos, correlationId }) {
  const { eventoId, localidad, cantidad, cliente, tipoTarifa = 'general', medioDePago = 'tarjeta' } = datos;

  const reserva = {
    id: `RES-${randomUUID().slice(0, 8).toUpperCase()}`,
    eventoId,
    localidad,
    cantidad,
    cliente,
    tipoTarifa,
    medioDePago,
    estado: ESTADOS.PENDIENTE,
    creadaEn: new Date().toISOString(),
    expiraEn: new Date(Date.now() + config.negocio.ttlReservaSegundos * 1000).toISOString(),
    correlationId,
    pasos: [],
  };

  const registrarPaso = (paso, estado, detalle) =>
    reserva.pasos.push({ paso, estado, detalle, ts: new Date().toISOString() });

  metricas.sagasIniciadas += 1;
  log.info('saga de compra iniciada', { correlationId, reserva: reserva.id, eventoId, localidad, cantidad });

  // ---------- Paso 1: reservar cupo ----------
  const cupo = await reservarCupo({ eventoId, localidad, cantidad, correlationId });
  registrarPaso('reservar-cupo', 'ok', { disponiblesAntes: cupo.disponiblesAntes });

  try {
    // ---------- Paso 2: precio ----------
    const precio = await obtenerPrecioBase({ eventoId, localidad, correlationId });
    const estrategia = obtenerEstrategia(tipoTarifa);
    const tarifa = estrategia.calcular({
      precioBaseCOP: precio.precioBaseCOP,
      cantidad,
      porcentajeOcupacion: cupo.porcentajeOcupacion,
    });
    Object.assign(reserva, {
      nombreEvento: precio.nombreEvento,
      nombreLocalidad: precio.nombreLocalidad,
      precioUnitarioCOP: precio.precioBaseCOP,
      tarifa,
      totalCOP: tarifa.totalCOP,
    });
    registrarPaso('calcular-tarifa', 'ok', tarifa);

    await repositorioReservas.guardar(reserva);
    await publicador.publicar('reservas', 'reserva.creada',
      { reservaId: reserva.id, eventoId, localidad, cantidad }, correlationId);

    // ---------- Paso 3: cobro ----------
    const cobro = await cobrar({
      reservaId: reserva.id, cliente, totalCOP: tarifa.totalCOP, medioDePago, correlationId,
    });
    registrarPaso('cobrar', 'ok', { transaccion: cobro.transaccionId, pasarela: cobro.pasarela });

    // ---------- Confirmacion ----------
    const clave = `${eventoId}:${localidad}`;
    await conReintentos(async () => {
      const fila = await repositorioInventario.buscarPorId(clave);
      fila.reservadas = Math.max(0, fila.reservadas - cantidad);
      fila.vendidas += cantidad;
      await repositorioInventario.guardarConVersion(fila, fila.version);
    }, {
      intentosMaximos: 12,
      esperaBaseMs: 4,
      calcularEspera: ESPERAS.jitterCorto,
      esTransitorio: (error) => error instanceof ConflictoDeConcurrenciaError,
    });

    reserva.estado = ESTADOS.CONFIRMADA;
    reserva.transaccionId = cobro.transaccionId;
    reserva.confirmadaEn = new Date().toISOString();
    registrarPaso('confirmar', 'ok', null);
    await repositorioReservas.guardar(reserva);

    await publicador.publicar('reservas', 'reserva.confirmada', {
      reservaId: reserva.id, eventoId, localidad, cantidad,
      cliente, totalCOP: reserva.totalCOP, nombreEvento: reserva.nombreEvento,
    }, correlationId);

    metricas.sagasCompletadas += 1;
    log.info('saga completada', { correlationId, reserva: reserva.id, totalCOP: reserva.totalCOP });
    return reserva;

  } catch (error) {
    // ---------- Compensacion ----------
    registrarPaso('compensar', 'ejecutada', { causa: error.message });
    reserva.estado = ESTADOS.CANCELADA;
    reserva.motivoCancelacion = error.message;
    await repositorioReservas.guardar(reserva);

    await liberarCupo({ eventoId, localidad, cantidad, correlationId });
    await publicador.publicar('reservas', 'reserva.cancelada',
      { reservaId: reserva.id, eventoId, localidad, cantidad, cliente, motivo: error.message }, correlationId);

    metricas.sagasCompensadas += 1;
    log.warn('saga compensada', { correlationId, reserva: reserva.id, causa: error.message });

    // Clasificacion del fallo hacia el cliente. Es importante que un rechazo
    // de la pasarela (402) o la falta de cupo (409) NO se reporten como 5xx:
    // el servicio de reservas esta sano y el cortacircuitos del gateway no
    // debe abrirse por una decision de negocio. Solo la indisponibilidad real
    // de una dependencia se reporta como 503.
    const codigo = Number.isInteger(error.estado) && error.estado >= 400 && error.estado < 500
      ? error.estado
      : 503;
    throw new ErrorHttp(codigo,
      'No fue posible completar la compra; la reserva fue liberada y no se realizo ningun cobro', {
        reservaId: reserva.id, estadoReserva: reserva.estado, causa: error.message, pasos: reserva.pasos,
      });
  }
}

/* ==================================================================== */
/* Rutas                                                                 */
/* ==================================================================== */

function validarEntrada(cuerpo) {
  const errores = [];
  if (!cuerpo.eventoId) errores.push('eventoId es obligatorio');
  if (!cuerpo.localidad) errores.push('localidad es obligatoria');
  if (!cuerpo.cliente) errores.push('cliente es obligatorio');
  const cantidad = Number(cuerpo.cantidad);
  if (!Number.isInteger(cantidad) || cantidad < 1) errores.push('cantidad debe ser un entero mayor que cero');
  else if (cantidad > config.negocio.maxSillasPorCompra) {
    errores.push(`cantidad no puede superar ${config.negocio.maxSillasPorCompra} boletas por compra`);
  }
  if (cuerpo.tipoTarifa && !TIPOS_DE_TARIFA.includes(cuerpo.tipoTarifa)) {
    errores.push(`tipoTarifa debe ser uno de: ${TIPOS_DE_TARIFA.join(', ')}`);
  }
  if (errores.length) throw new ErrorHttp(400, 'Datos de la reserva invalidos', errores);
  return { ...cuerpo, cantidad };
}

const rutas = [
  {
    metodo: 'POST',
    ruta: '/reservas',
    manejador: async ({ peticion, cuerpo, correlationId }) => {
      const datos = validarEntrada(cuerpo);
      const claveIdempotencia = peticion.headers[CABECERA_IDEMPOTENCIA];

      // ---- Idempotent Receiver -------------------------------------
      if (claveIdempotencia && registroIdempotencia.has(claveIdempotencia)) {
        metricas.respuestasIdempotentes += 1;
        log.info('peticion duplicada resuelta por idempotencia', { correlationId, claveIdempotencia });
        return conEstado(200, {
          ...registroIdempotencia.get(claveIdempotencia), reutilizadaPorIdempotencia: true,
        });
      }

      const reserva = await ejecutarSagaDeCompra({ datos, correlationId });
      if (claveIdempotencia) registroIdempotencia.set(claveIdempotencia, reserva);
      return conEstado(201, reserva);
    },
  },

  {
    metodo: 'GET',
    ruta: '/reservas/:id',
    manejador: async ({ parametros }) => {
      const reserva = await repositorioReservas.buscarPorId(parametros.id);
      if (!reserva) throw new ErrorHttp(404, `La reserva "${parametros.id}" no existe`);
      return reserva;
    },
  },

  {
    metodo: 'GET',
    ruta: '/reservas',
    manejador: async ({ url }) => {
      const cliente = url.searchParams.get('cliente');
      const filtro = cliente ? (r) => r.cliente === cliente : () => true;
      const reservas = await repositorioReservas.listar(filtro);
      return { total: reservas.length, reservas: reservas.sort((a, b) => b.creadaEn.localeCompare(a.creadaEn)) };
    },
  },

  /** Transaccion compensatoria posterior: reembolso de una compra confirmada. */
  {
    metodo: 'POST',
    ruta: '/reservas/:id/reembolso',
    manejador: async ({ parametros, cuerpo, correlationId }) => {
      const reserva = await repositorioReservas.buscarPorId(parametros.id);
      if (!reserva) throw new ErrorHttp(404, `La reserva "${parametros.id}" no existe`);
      if (reserva.estado !== ESTADOS.CONFIRMADA) {
        throw new ErrorHttp(409, `Solo se reembolsan reservas CONFIRMADAS (esta esta ${reserva.estado})`);
      }

      const reverso = await clientePagos.post(`/cobros/${reserva.transaccionId}/reverso`, {
        motivo: cuerpo.motivo ?? 'solicitud del cliente',
      }, { correlationId });

      await liberarCupo({
        eventoId: reserva.eventoId, localidad: reserva.localidad,
        cantidad: reserva.cantidad, vendida: true, correlationId,
      });

      reserva.estado = ESTADOS.REEMBOLSADA;
      reserva.reembolsadaEn = new Date().toISOString();
      reserva.pasos.push({ paso: 'reembolsar', estado: 'ok', detalle: reverso, ts: reserva.reembolsadaEn });
      await repositorioReservas.guardar(reserva);

      await publicador.publicar('reservas', 'reserva.reembolsada', {
        reservaId: reserva.id, eventoId: reserva.eventoId, localidad: reserva.localidad,
        cantidad: reserva.cantidad, cliente: reserva.cliente, totalCOP: reserva.totalCOP,
      }, correlationId);

      return reserva;
    },
  },

  {
    metodo: 'GET',
    ruta: '/inventario/:eventoId',
    manejador: async ({ parametros }) => {
      const filas = await repositorioInventario.listar((f) => f.eventoId === parametros.eventoId);
      return {
        eventoId: parametros.eventoId,
        origen: 'almacen-autoritativo',
        localidades: filas.map((f) => ({
          localidad: f.localidad,
          capacidad: f.capacidad,
          vendidas: f.vendidas,
          reservadas: f.reservadas,
          disponibles: f.capacidad - f.vendidas - f.reservadas,
          version: f.version,
        })),
      };
    },
  },

  {
    metodo: 'GET',
    ruta: '/diagnostico',
    manejador: () => ({
      servicio: 'reservas',
      metricas,
      clavesIdempotencia: registroIdempotencia.size,
      dependencias: [clienteCatalogo.instantanea(), clientePagos.instantanea()],
    }),
  },
];

/* ==================================================================== */
/* Scheduler Agent Supervisor: barre reservas colgadas                   */
/* ==================================================================== */

async function barrerReservasExpiradas() {
  const ahora = Date.now();
  const pendientes = await repositorioReservas.listar(
    (r) => r.estado === ESTADOS.PENDIENTE && Date.parse(r.expiraEn) < ahora,
  );
  for (const reserva of pendientes) {
    reserva.estado = ESTADOS.EXPIRADA;
    await repositorioReservas.guardar(reserva);
    await liberarCupo({
      eventoId: reserva.eventoId, localidad: reserva.localidad,
      cantidad: reserva.cantidad, correlationId: reserva.correlationId,
    });
    await publicador.publicar('reservas', 'reserva.expirada', {
      reservaId: reserva.id, eventoId: reserva.eventoId,
      localidad: reserva.localidad, cantidad: reserva.cantidad,
    }, reserva.correlationId);
    metricas.reservasExpiradas += 1;
    log.warn('reserva expirada y cupo devuelto', { reserva: reserva.id });
  }
}

crearServidor({
  nombre: 'reservas',
  puerto: config.puertoDe('reservas'),
  rutas,
  sondaSalud: () => ({
    ok: clientePagos.cortacircuitos.estado !== 'ABIERTO',
    detalle: {
      circuitoPagos: clientePagos.cortacircuitos.estado,
      circuitoCatalogo: clienteCatalogo.cortacircuitos.estado,
      reservas: repositorioReservas.tamano,
    },
  }),
});

setInterval(() => {
  barrerReservasExpiradas().catch((e) => log.error('fallo el barrido de reservas', { causa: e.message }));
}, 30_000).unref();
