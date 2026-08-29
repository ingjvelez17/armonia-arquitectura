/**
 * ============================================================================
 *  API GATEWAY  (puerto 8080)  -  unica puerta de entrada del sistema
 * ============================================================================
 *
 * Patrones aplicados:
 *   - Gateway Routing      : una sola URL publica; el enrutado interno es un
 *                            detalle de implementacion que puede cambiar sin
 *                            afectar a las apps cliente.
 *   - Gateway Aggregation  : /api/bff/evento/:id resuelve en UNA llamada lo que
 *                            serian tres. Critico en movil: menos viajes de red.
 *   - Gateway Offloading   : autenticacion, limitacion de tasa, CORS y
 *                            correlacion se resuelven aqui una sola vez, no
 *                            replicados en los cinco microservicios.
 *   - Backend for Frontend : la respuesta se moldea para lo que la interfaz
 *                            necesita pintar, no para lo que el dominio guarda.
 *   - Throttling           : token bucket por clave de cliente.
 *   - Circuit Breaker      : heredado del ClienteServicio (Ambassador).
 *
 * Advertencia de diseno documentada en el informe: el gateway es un punto
 * unico de fallo si se despliega una sola instancia. En produccion va detras
 * de un balanceador con minimo dos replicas en zonas distintas.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearServidor, responder, conEstado, CABECERA_IDEMPOTENCIA } from '../../lib/http.js';
import { config } from '../../lib/config.js';
import { crearLogger } from '../../lib/logger.js';
import { LimitadorDeTasa } from '../../lib/resiliencia.js';
import { ClienteServicio } from '../../lib/cliente-servicio.js';

const log = crearLogger('gateway');
const DIRECTORIO_WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const catalogo = new ClienteServicio('catalogo', config.servicios.catalogo, log);
const reservas = new ClienteServicio('reservas', config.servicios.reservas, log);
/**
 * Cortacircuitos SEPARADO para la ruta de compra.
 *
 * Aunque apunta al mismo servicio, tiene su propio estado. Motivo: si la
 * pasarela de pagos cae, las compras fallan pero las CONSULTAS de reservas
 * siguen sanas. Con un unico cortacircuitos por servicio, el fallo de pagos
 * dejaria tambien sin consultar "mis compras". Separar el circuito por ruta
 * critica es la aplicacion del principio de mamparo al nivel del gateway.
 */
const reservasCompra = new ClienteServicio('reservas:compra', config.servicios.reservas, log);
const pagos = new ClienteServicio('pagos', config.servicios.pagos, log);
const notificaciones = new ClienteServicio('notificaciones', config.servicios.notificaciones, log);
const broker = new ClienteServicio('broker', config.servicios.broker, log);

const limitador = new LimitadorDeTasa(config.resiliencia.limitePeticionesPorMinuto, 60_000);

/** Claves de API validas (en produccion: Azure AD B2C / Cognito / Auth0). */
const CLAVES_VALIDAS = new Set((process.env.CLAVES_API ?? 'demo-armonia-2026,panel-interno').split(','));

const metricas = { peticiones: 0, rechazadasPorLimite: 0, noAutorizadas: 0, agregaciones: 0 };

const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/* ==================================================================== */
/* Middleware: offloading transversal                                    */
/* ==================================================================== */

async function offloading({ peticion, respuesta, url }) {
  metricas.peticiones += 1;

  // ---- CORS (una sola vez, no en cada microservicio) ----
  respuesta.setHeader('access-control-allow-origin', '*');
  respuesta.setHeader('access-control-allow-headers', 'content-type,x-api-key,idempotency-key,x-correlation-id');
  respuesta.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (peticion.method === 'OPTIONS') {
    respuesta.writeHead(204).end();
    return false;
  }

  // ---- Contenido estatico del panel de demostracion ----
  if (!url.pathname.startsWith('/api/')) {
    const relativa = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const destino = path.join(DIRECTORIO_WEB, relativa);
    // Proteccion contra "path traversal": nunca salir del directorio web.
    if (!destino.startsWith(DIRECTORIO_WEB)) {
      responder(respuesta, 403, 'Acceso denegado');
      return false;
    }
    try {
      const contenido = await readFile(destino);
      respuesta.writeHead(200, { 'content-type': TIPOS_MIME[path.extname(destino)] ?? 'application/octet-stream' });
      respuesta.end(contenido);
      return false;
    } catch {
      responder(respuesta, 404, 'Recurso no encontrado');
      return false;
    }
  }

  // ---- Throttling: token bucket por clave o IP ----
  const identidad = peticion.headers['x-api-key'] ?? peticion.socket.remoteAddress ?? 'anonimo';
  const veredicto = limitador.permitir(identidad);
  respuesta.setHeader('x-rate-limit-restantes', String(veredicto.restantes));
  if (!veredicto.permitido) {
    metricas.rechazadasPorLimite += 1;
    log.warn('peticion rechazada por limitacion de tasa', { identidad });
    responder(respuesta, 429, {
      error: 'Demasiadas peticiones. Intente de nuevo en unos segundos.',
      reintentarEnS: veredicto.reintentarEnS,
    }, { 'retry-after': String(veredicto.reintentarEnS) });
    return false;
  }

  // ---- Autenticacion: solo para operaciones que modifican estado ----
  if (['POST', 'PUT', 'DELETE'].includes(peticion.method)) {
    const clave = peticion.headers['x-api-key'];
    if (!CLAVES_VALIDAS.has(clave)) {
      metricas.noAutorizadas += 1;
      responder(respuesta, 401, {
        error: 'Falta o es invalida la cabecera x-api-key',
        pista: 'Use x-api-key: demo-armonia-2026',
      });
      return false;
    }
  }
  return true;
}

/* ==================================================================== */
/* Rutas                                                                 */
/* ==================================================================== */

const rutas = [
  /* ---- Gateway Routing: proxy simple hacia catalogo ---- */
  {
    metodo: 'GET',
    ruta: '/api/eventos',
    manejador: ({ url, correlationId }) =>
      catalogo.get(`/eventos${url.search}`, {
        correlationId,
        // Degradacion elegante: si el catalogo cae, el usuario ve una lista
        // vacia con aviso en vez de un error 500 en toda la portada.
        respaldo: () => ({ origen: 'respaldo', total: 0, eventos: [], degradado: true }),
      }),
  },
  {
    metodo: 'GET',
    ruta: '/api/eventos/:id',
    manejador: ({ parametros, correlationId }) => catalogo.get(`/eventos/${parametros.id}`, { correlationId }),
  },

  /* ---- Gateway Aggregation / BFF ---- */
  {
    metodo: 'GET',
    ruta: '/api/bff/evento/:id',
    manejador: async ({ parametros, correlationId }) => {
      metricas.agregaciones += 1;
      const { id } = parametros;

      // Las tres llamadas van EN PARALELO: el tiempo total es el de la mas
      // lenta, no la suma. Y ninguna puede tumbar la respuesta completa.
      const [detalle, disponibilidad, inventario] = await Promise.all([
        catalogo.get(`/eventos/${id}`, { correlationId }),
        catalogo.get(`/eventos/${id}/disponibilidad`, {
          correlationId,
          respaldo: () => ({ localidades: [], degradado: true }),
        }),
        reservas.get(`/inventario/${id}`, {
          correlationId,
          respaldo: () => ({ localidades: [], degradado: true }),
        }),
      ]);

      // Moldeado para la interfaz: se fusiona precio (catalogo) con cupo real
      // (reservas) en una sola estructura lista para pintar.
      const cupoPorLocalidad = new Map(inventario.localidades.map((l) => [l.localidad, l]));
      const localidades = detalle.evento.localidades.map((l) => {
        const cupo = cupoPorLocalidad.get(l.codigo);
        return {
          codigo: l.codigo,
          nombre: l.nombre,
          precioCOP: l.precioCOP,
          capacidad: l.capacidad,
          disponibles: cupo?.disponibles ?? null,
          vendidas: cupo?.vendidas ?? null,
          agotada: cupo ? cupo.disponibles <= 0 : false,
        };
      });

      return {
        evento: {
          id: detalle.evento.id,
          nombre: detalle.evento.nombre,
          artista: detalle.evento.artista,
          genero: detalle.evento.genero,
          ciudad: detalle.evento.ciudad,
          escenario: detalle.evento.escenario,
          fecha: detalle.evento.fecha,
          estado: detalle.evento.estado,
        },
        localidades,
        vistaEventual: disponibilidad.localidades ?? [],
        origenes: {
          detalle: detalle.origen,
          disponibilidad: disponibilidad.origen ?? 'degradado',
          inventario: inventario.origen ?? 'degradado',
        },
        agregadoPor: 'api-gateway',
        llamadasAhorradasAlCliente: 2,
      };
    },
  },

  /* ---- Reservas ---- */
  {
    metodo: 'POST',
    ruta: '/api/reservas',
    manejador: async ({ peticion, cuerpo, correlationId }) => {
      const { estado, datos } = await reservasCompra.post('/reservas', cuerpo, {
        correlationId,
        // La clave de idempotencia del cliente se propaga intacta.
        cabeceras: peticion.headers[CABECERA_IDEMPOTENCIA]
          ? { [CABECERA_IDEMPOTENCIA]: peticion.headers[CABECERA_IDEMPOTENCIA] }
          : {},
        sinReintentos: true,  // una compra NO se reintenta a ciegas desde el borde
        incluirEstado: true,  // 201 = creada, 200 = respuesta idempotente
      });
      return conEstado(estado, datos);
    },
  },
  {
    metodo: 'GET',
    ruta: '/api/reservas',
    manejador: ({ url, correlationId }) => reservas.get(`/reservas${url.search}`, { correlationId }),
  },
  {
    metodo: 'GET',
    ruta: '/api/reservas/:id',
    manejador: ({ parametros, correlationId }) => reservas.get(`/reservas/${parametros.id}`, { correlationId }),
  },
  {
    metodo: 'POST',
    ruta: '/api/reservas/:id/reembolso',
    manejador: ({ parametros, cuerpo, correlationId }) =>
      reservasCompra.post(`/reservas/${parametros.id}/reembolso`, cuerpo, { correlationId, sinReintentos: true }),
  },

  {
    metodo: 'GET',
    ruta: '/api/notificaciones',
    manejador: ({ url, correlationId }) =>
      notificaciones.get(`/notificaciones${url.search}`, {
        correlationId,
        respaldo: () => ({ total: 0, notificaciones: [], degradado: true }),
      }),
  },

  /* ---- Panel de control: agrega el diagnostico de toda la malla ---- */
  {
    metodo: 'GET',
    ruta: '/api/panel',
    manejador: async ({ correlationId }) => {
      const sinFallo = (promesa) => promesa.catch((e) => ({ error: e.message, caido: true }));
      // `sinCircuito` es deliberado: la observabilidad no debe quedarse ciega
      // justo cuando el sistema esta roto, que es cuando mas se necesita.
      const opciones = { correlationId, sinReintentos: true, sinCircuito: true };
      const [dCatalogo, dReservas, dPagos, dNotificaciones, dBroker] = await Promise.all([
        sinFallo(catalogo.get('/diagnostico', opciones)),
        sinFallo(reservas.get('/diagnostico', opciones)),
        sinFallo(pagos.get('/diagnostico', opciones)),
        sinFallo(notificaciones.get('/diagnostico', opciones)),
        sinFallo(broker.get('/colas', opciones)),
      ]);
      return {
        generadoEn: new Date().toISOString(),
        gateway: {
        metricas,
        circuitos: [catalogo, reservas, reservasCompra, pagos, notificaciones].map((c) => c.instantanea()),
      },
        catalogo: dCatalogo,
        reservas: dReservas,
        pagos: dPagos,
        notificaciones: dNotificaciones,
        broker: dBroker,
      };
    },
  },

  /* ---- Health Endpoint Monitoring agregado ---- */
  {
    metodo: 'GET',
    ruta: '/api/salud',
    manejador: async ({ correlationId }) => {
      const clientes = { catalogo, reservas, pagos, notificaciones, broker };
      const resultados = await Promise.all(
        Object.entries(clientes).map(async ([nombre, cliente]) => {
          const inicio = Date.now();
          try {
            const salud = await cliente.get('/health/ready', { correlationId, sinReintentos: true, sinCircuito: true });
            return { servicio: nombre, estado: salud.estado, latenciaMs: Date.now() - inicio };
          } catch (error) {
            return { servicio: nombre, estado: 'caido', latenciaMs: Date.now() - inicio, causa: error.message };
          }
        }),
      );
      const saludables = resultados.filter((r) => r.estado === 'listo').length;
      return {
        estadoGeneral: saludables === resultados.length ? 'operativo'
          : saludables === 0 ? 'caido' : 'degradado',
        saludables,
        total: resultados.length,
        servicios: resultados,
      };
    },
  },

  /* ---- Panel de caos (para la demostracion en vivo) ---- */
  {
    metodo: 'POST',
    ruta: '/api/caos',
    manejador: ({ cuerpo, correlationId }) => pagos.post('/caos', cuerpo, { correlationId, sinReintentos: true, sinCircuito: true }),
  },
  {
    metodo: 'GET',
    ruta: '/api/caos',
    manejador: ({ correlationId }) => pagos.get('/caos', { correlationId, sinReintentos: true, sinCircuito: true }),
  },
];

crearServidor({
  nombre: 'api-gateway',
  puerto: config.puertoDe('gateway'),
  rutas,
  antesDe: offloading,
  sondaSalud: () => ({ ok: true, detalle: { metricas } }),
});

log.info('panel de demostracion disponible en http://127.0.0.1:' + config.puertoDe('gateway'));
