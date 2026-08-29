/**
 * Micro-framework HTTP construido solo con la libreria estandar de Node.js.
 *
 * Decision de arquitectura (ver docs/adr/ADR-004): el prototipo no usa
 * dependencias externas (Express, Fastify, etc.). Motivos:
 *   1. Reproducibilidad: `git clone` + `node` y funciona; no hay `npm install`
 *      que pueda romperse ni superficie de ataque de terceros.
 *   2. Didactico: los patrones (Gateway, Circuit Breaker, Retry) quedan
 *      visibles en el codigo en lugar de ocultos en un framework.
 *   3. Portabilidad: la imagen de contenedor pesa lo que pese Node y nada mas.
 *
 * Patron aplicado: Facade (GoF). `crearServidor` esconde la complejidad del
 * modulo `node:http` detras de una interfaz simple y uniforme para los seis
 * microservicios.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { crearLogger } from './logger.js';

export const CABECERA_CORRELACION = 'x-correlation-id';
export const CABECERA_IDEMPOTENCIA = 'idempotency-key';

const BARRA_INVERSA = String.fromCharCode(92);
const METACARACTERES = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']']);
const escaparRegex = (texto) =>
  [...texto].map((c) => (METACARACTERES.has(c) ? BARRA_INVERSA + c : c)).join('');

/** Convierte "/eventos/:id/sillas" en una expresion regular con grupos nombrados. */
function compilarRuta(patron) {
  const nombres = [];
  const expresion = patron
    .split('/')
    .map((segmento) => {
      if (segmento.startsWith(':')) {
        nombres.push(segmento.slice(1));
        return '([^/]+)';
      }
      // Los patrones de ruta los define el propio servicio (no vienen del
      // usuario), por eso basta con escapar los metacaracteres mas comunes.
      return escaparRegex(segmento);
    })
    .join('/');
  return { regex: new RegExp(`^${expresion}/?$`), nombres };
}

export function leerCuerpo(peticion, limiteBytes = 1_000_000) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let total = 0;
    peticion.on('data', (trozo) => {
      total += trozo.length;
      if (total > limiteBytes) {
        rechazar(new Error('Cuerpo de la peticion demasiado grande'));
        peticion.destroy();
        return;
      }
      trozos.push(trozo);
    });
    peticion.on('end', () => {
      const crudo = Buffer.concat(trozos).toString('utf8');
      if (!crudo) return resolver({});
      try {
        resolver(JSON.parse(crudo));
      } catch {
        rechazar(new Error('JSON invalido en el cuerpo de la peticion'));
      }
    });
    peticion.on('error', rechazar);
  });
}

export function responder(respuesta, estado, cuerpo, cabeceras = {}) {
  const carga = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo, null, 2);
  respuesta.writeHead(estado, {
    'content-type': typeof cuerpo === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...cabeceras,
  });
  respuesta.end(carga);
}

/**
 * Envoltorio para que un manejador fije el codigo de estado sin ambiguedad.
 *
 * No se usa un objeto plano { estado, cuerpo } porque las entidades del
 * dominio tienen su propio campo `estado` ("CONFIRMADA", "APROBADO"...) y el
 * servidor lo confundiria con un codigo HTTP. Un tipo explicito elimina esa
 * colision de nombres.
 */
export class RespuestaHttp {
  constructor(estado, cuerpo, cabeceras = {}) {
    this.estado = estado;
    this.cuerpo = cuerpo;
    this.cabeceras = cabeceras;
  }
}

export const conEstado = (estado, cuerpo, cabeceras = {}) =>
  new RespuestaHttp(estado, cuerpo, cabeceras);

/** Error de dominio con codigo HTTP asociado. */
export class ErrorHttp extends Error {
  constructor(estado, mensaje, detalle = null) {
    super(mensaje);
    this.estado = estado;
    this.detalle = detalle;
  }
}

/**
 * Crea y arranca un microservicio.
 *
 * @param {object} opciones
 * @param {string} opciones.nombre        Nombre del servicio (para logs y /health).
 * @param {number} opciones.puerto        Puerto de escucha.
 * @param {Array}  opciones.rutas         [{ metodo, ruta, manejador }]
 * @param {Function} [opciones.sondaSalud] Devuelve {ok:boolean, detalle:object}.
 * @param {Function} [opciones.antesDe]   Middleware ejecutado antes del enrutado.
 */
export function crearServidor({ nombre, puerto, rutas, sondaSalud, antesDe }) {
  const log = crearLogger(nombre);
  const compiladas = rutas.map((r) => ({ ...r, ...compilarRuta(r.ruta) }));
  const arranque = Date.now();
  const metricas = { peticiones: 0, errores: 0, porRuta: {} };

  const servidor = http.createServer(async (peticion, respuesta) => {
    const inicio = Date.now();
    // Correlation Identifier: se reutiliza el que llega o se genera uno nuevo.
    const correlationId = peticion.headers[CABECERA_CORRELACION] || randomUUID();
    peticion.correlationId = correlationId;
    respuesta.setHeader(CABECERA_CORRELACION, correlationId);

    const url = new URL(peticion.url, `http://${peticion.headers.host ?? 'localhost'}`);
    metricas.peticiones += 1;

    try {
      // ---- Health Endpoint Monitoring Pattern -------------------------------
      if (url.pathname === '/health') {
        return responder(respuesta, 200, {
          servicio: nombre,
          estado: 'vivo',
          uptimeSegundos: Math.round((Date.now() - arranque) / 1000),
        });
      }
      if (url.pathname === '/health/ready') {
        const sonda = sondaSalud ? await sondaSalud() : { ok: true, detalle: {} };
        return responder(respuesta, sonda.ok ? 200 : 503, {
          servicio: nombre,
          estado: sonda.ok ? 'listo' : 'degradado',
          ...sonda.detalle,
        });
      }
      if (url.pathname === '/metrics') {
        return responder(respuesta, 200, { servicio: nombre, ...metricas });
      }

      if (antesDe) {
        const cortocircuito = await antesDe({ peticion, respuesta, url, log });
        if (cortocircuito === false) return; // el middleware ya respondio
      }

      for (const ruta of compiladas) {
        if (ruta.metodo !== peticion.method) continue;
        const coincidencia = ruta.regex.exec(url.pathname);
        if (!coincidencia) continue;

        const parametros = {};
        ruta.nombres.forEach((n, i) => { parametros[n] = decodeURIComponent(coincidencia[i + 1]); });
        const cuerpo = ['POST', 'PUT', 'PATCH'].includes(peticion.method)
          ? await leerCuerpo(peticion)
          : {};

        metricas.porRuta[ruta.ruta] = (metricas.porRuta[ruta.ruta] ?? 0) + 1;
        const resultado = await ruta.manejador({
          peticion, respuesta, parametros, cuerpo, url, correlationId, log,
        });

        if (resultado !== undefined && !respuesta.writableEnded) {
          if (resultado instanceof RespuestaHttp) {
            responder(respuesta, resultado.estado, resultado.cuerpo, resultado.cabeceras);
          } else {
            responder(respuesta, 200, resultado);
          }
        }
        log.debug('peticion atendida', {
          correlationId, metodo: peticion.method, ruta: url.pathname, ms: Date.now() - inicio,
        });
        return;
      }

      responder(respuesta, 404, { error: 'Recurso no encontrado', ruta: url.pathname });
    } catch (error) {
      metricas.errores += 1;
      // Se respeta el codigo del error de dominio y tambien el que venga de un
      // servicio aguas abajo, para no convertir un 409 de negocio en un 500.
      const estado = Number.isInteger(error.estado) && error.estado >= 400 && error.estado <= 599
        ? error.estado
        : 500;
      if (estado >= 500) {
        log.error('fallo al atender la peticion', { correlationId, ruta: url.pathname, error: error.message });
      } else {
        log.warn('peticion rechazada', { correlationId, ruta: url.pathname, error: error.message });
      }
      if (!respuesta.writableEnded) {
        // Si el error viene de un servicio interno, se reenvia SU cuerpo tal
        // cual: el cliente recibe el mensaje de negocio, no un envoltorio.
        const cuerpo = error.cuerpo && typeof error.cuerpo === 'object'
          ? { ...error.cuerpo, correlationId }
          : { error: error.message, detalle: error.detalle ?? undefined, correlationId };
        responder(respuesta, estado, cuerpo);
      }
    }
  });

  servidor.listen(puerto, () => {
    log.info(`escuchando en http://127.0.0.1:${puerto}`);
  });

  // Graceful shutdown: en la nube el orquestador envia SIGTERM antes de matar
  // el contenedor. Cerrar limpio evita cortar peticiones en vuelo.
  const apagar = () => {
    log.info('SIGTERM recibido, cerrando conexiones');
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);

  return { servidor, log, metricas };
}
