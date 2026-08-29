/**
 * ============================================================================
 *  SERVICIO DE CATALOGO  (puerto 8081)
 * ============================================================================
 *
 * Responsabilidad unica: responder consultas sobre eventos y disponibilidad.
 * Es el servicio con MAS lecturas y CASI NINGUNA escritura, por eso concentra
 * los patrones orientados a lectura:
 *
 *   - Cache-Aside            : evita golpear la BD en cada consulta.
 *   - CQRS (lado de lectura) : mantiene una vista materializada de la
 *                              disponibilidad que se actualiza por eventos,
 *                              no consultando al servicio de reservas.
 *   - Materialized View      : `proyeccionDisponibilidad` es esa vista.
 *   - Repository             : abstrae el almacen del servicio.
 *   - Database per Service   : nadie mas lee esta base de datos.
 *
 * Consistencia: la disponibilidad es EVENTUALMENTE consistente (se actualiza
 * milisegundos despues de la reserva). Es una decision consciente: mostrar
 * "quedan 43 boletas" con un desfase de 200 ms es aceptable; lo que NO puede
 * fallar es la reserva en si, y esa la valida el servicio de reservas contra
 * su propio almacen autoritativo (ver ADR-003).
 */

import { crearServidor, ErrorHttp } from '../../lib/http.js';
import { config } from '../../lib/config.js';
import { crearLogger } from '../../lib/logger.js';
import { CacheEnMemoria } from '../../lib/cache.js';
import { RepositorioEnMemoria } from '../../lib/repositorio.js';
import { Consumidor } from '../../lib/bus.js';
import { EVENTOS_SEMILLA } from './datos.js';

const log = crearLogger('catalogo');

/* -------------------------------------------------------------------- */
/* Almacen propio del servicio (con latencia simulada) + cache            */
/* -------------------------------------------------------------------- */

const repositorioEventos = new RepositorioEnMemoria('eventos', config.negocio.latenciaBaseDatosMs)
  .sembrar(EVENTOS_SEMILLA);

const cache = new CacheEnMemoria({ ttlSegundos: config.negocio.ttlCacheSegundos, tamanoMaximo: 500 });

/**
 * Vista materializada (lado de lectura de CQRS).
 * eventoId -> { codigoLocalidad -> { capacidad, vendidas, reservadas } }
 * Se inicializa con la capacidad del catalogo y se ajusta con los eventos de
 * dominio que publica el servicio de reservas.
 */
const proyeccionDisponibilidad = new Map();
for (const evento of EVENTOS_SEMILLA) {
  const porLocalidad = {};
  for (const localidad of evento.localidades) {
    porLocalidad[localidad.codigo] = { capacidad: localidad.capacidad, vendidas: 0, reservadas: 0 };
  }
  proyeccionDisponibilidad.set(evento.id, porLocalidad);
}

const estadisticasProyeccion = { eventosAplicados: 0, ultimoEvento: null, desconocidos: 0 };

function aplicarEventoDeDominio(mensaje) {
  const { tipo, datos } = mensaje;
  const porLocalidad = proyeccionDisponibilidad.get(datos.eventoId);
  if (!porLocalidad || !porLocalidad[datos.localidad]) {
    estadisticasProyeccion.desconocidos += 1;
    return;
  }
  const celda = porLocalidad[datos.localidad];

  switch (tipo) {
    case 'reserva.creada':
      celda.reservadas += datos.cantidad;
      break;
    case 'reserva.confirmada':
      celda.reservadas = Math.max(0, celda.reservadas - datos.cantidad);
      celda.vendidas += datos.cantidad;
      break;
    case 'reserva.cancelada':
    case 'reserva.expirada':
      celda.reservadas = Math.max(0, celda.reservadas - datos.cantidad);
      break;
    case 'reserva.reembolsada':
      celda.vendidas = Math.max(0, celda.vendidas - datos.cantidad);
      break;
    default:
      estadisticasProyeccion.desconocidos += 1;
      return;
  }

  estadisticasProyeccion.eventosAplicados += 1;
  estadisticasProyeccion.ultimoEvento = tipo;
  // La disponibilidad cambio: se invalida la cache de ese evento.
  cache.invalidarPorPrefijo(`disponibilidad:${datos.eventoId}`);
  log.debug('proyeccion actualizada', {
    correlationId: mensaje.correlationId, tipo, evento: datos.eventoId, localidad: datos.localidad,
  });
}

function calcularDisponibilidad(eventoId) {
  const porLocalidad = proyeccionDisponibilidad.get(eventoId);
  if (!porLocalidad) return null;
  return Object.entries(porLocalidad).map(([codigo, c]) => ({
    localidad: codigo,
    capacidad: c.capacidad,
    vendidas: c.vendidas,
    reservadas: c.reservadas,
    disponibles: c.capacidad - c.vendidas - c.reservadas,
    porcentajeOcupacion: Number((((c.vendidas + c.reservadas) / c.capacidad) * 100).toFixed(1)),
  }));
}

/* -------------------------------------------------------------------- */
/* Rutas                                                                 */
/* -------------------------------------------------------------------- */

const rutas = [
  {
    metodo: 'GET',
    ruta: '/eventos',
    manejador: async ({ url, correlationId }) => {
      const ciudad = url.searchParams.get('ciudad');
      const clave = `eventos:lista:${ciudad ?? 'todas'}`;

      // ---- Cache-Aside: primero la cache, si falla se va al origen ----
      const { valor, desdeCache } = await cache.resolver(clave, async () => {
        const filtro = ciudad
          ? (e) => e.ciudad.toLowerCase() === ciudad.toLowerCase()
          : () => true;
        return repositorioEventos.listar(filtro);
      });

      log.info('consulta de catalogo', { correlationId, ciudad, desdeCache, resultados: valor.length });
      return {
        origen: desdeCache ? 'cache' : 'base-de-datos',
        total: valor.length,
        eventos: valor,
      };
    },
  },

  {
    metodo: 'GET',
    ruta: '/eventos/:id',
    manejador: async ({ parametros, correlationId }) => {
      const { valor, desdeCache } = await cache.resolver(
        `evento:${parametros.id}`,
        () => repositorioEventos.buscarPorId(parametros.id),
      );
      if (!valor) throw new ErrorHttp(404, `El evento "${parametros.id}" no existe`);
      log.info('detalle de evento', { correlationId, evento: parametros.id, desdeCache });
      return { origen: desdeCache ? 'cache' : 'base-de-datos', evento: valor };
    },
  },

  {
    metodo: 'GET',
    ruta: '/eventos/:id/disponibilidad',
    manejador: async ({ parametros, correlationId }) => {
      const { valor, desdeCache } = await cache.resolver(
        `disponibilidad:${parametros.id}`,
        async () => calcularDisponibilidad(parametros.id),
        5, // TTL corto: es un dato que cambia mucho
      );
      if (!valor) throw new ErrorHttp(404, `El evento "${parametros.id}" no existe`);
      return {
        eventoId: parametros.id,
        origen: desdeCache ? 'cache' : 'vista-materializada',
        consistencia: 'eventual',
        localidades: valor,
      };
    },
  },

  /** Endpoint de diagnostico: hace visibles los patrones para la demo. */
  {
    metodo: 'GET',
    ruta: '/diagnostico',
    manejador: () => ({
      servicio: 'catalogo',
      cache: cache.instantanea(),
      repositorio: { entidades: repositorioEventos.tamano, operaciones: repositorioEventos.operaciones },
      proyeccionCQRS: estadisticasProyeccion,
      consumidor: consumidor?.instantanea() ?? null,
    }),
  },
];

/* -------------------------------------------------------------------- */
/* Suscripcion a los eventos de dominio (lado de lectura de CQRS)        */
/* -------------------------------------------------------------------- */

const consumidor = new Consumidor({
  cola: 'proyeccion-catalogo',
  identidad: 'catalogo-proyector',
  topicos: ['reservas'],
  manejar: async (mensaje) => aplicarEventoDeDominio(mensaje),
  intervaloMs: 250,
  log,
});

crearServidor({
  nombre: 'catalogo',
  puerto: config.puertoDe('catalogo'),
  rutas,
  sondaSalud: () => ({
    ok: true,
    detalle: { eventos: repositorioEventos.tamano, tasaAciertosCache: cache.instantanea().tasaAciertos },
  }),
});

// El consumidor arranca en segundo plano; si el broker aun no esta arriba,
// el propio bucle reintenta sin tumbar el servicio.
(async () => {
  try {
    await consumidor.suscribir();
  } catch (error) {
    log.warn('no se pudo suscribir al broker todavia; se reintentara', { causa: error.message });
  }
  consumidor.iniciar();
})();
