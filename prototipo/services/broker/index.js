/**
 * ============================================================================
 *  BROKER DE MENSAJES  (puerto 8085)
 * ============================================================================
 *
 * Sustituye en el prototipo a Amazon SQS/SNS, Azure Service Bus o RabbitMQ.
 * Implementa, con la misma semantica que esos productos, cuatro patrones:
 *
 *   1. Publisher-Subscriber      : quien publica no conoce a los consumidores.
 *   2. Queue-Based Load Leveling : la cola absorbe los picos; los consumidores
 *                                  trabajan a su ritmo y nada se pierde.
 *   3. Competing Consumers       : N trabajadores leen de la MISMA cola; cada
 *                                  mensaje lo procesa exactamente uno gracias
 *                                  al arrendamiento con "visibility timeout".
 *   4. Dead Letter Queue         : el mensaje que falla N veces se aparta en
 *                                  lugar de bloquear la cola ("poison message").
 *
 * Se mantiene deliberadamente en memoria: es un prototipo academico. La
 * sustitucion por un broker gestionado no cambia una sola linea de los
 * servicios, porque todos hablan con el a traves de lib/bus.js.
 */

import { randomUUID } from 'node:crypto';
import { crearServidor, ErrorHttp, conEstado } from '../../lib/http.js';
import { config } from '../../lib/config.js';
import { crearLogger } from '../../lib/logger.js';

const log = crearLogger('broker');

const VISIBILIDAD_MS = 10_000;   // tiempo que un mensaje arrendado queda oculto
const MAX_ENTREGAS = 3;          // entregas antes de mandarlo a la DLQ

/** cola -> { mensajes: [], dlq: [], suscripciones: Set<topico> } */
const colas = new Map();
const metricas = { publicados: 0, entregados: 0, confirmados: 0, reencolados: 0, aDlq: 0 };

function obtenerCola(nombre) {
  if (!colas.has(nombre)) {
    colas.set(nombre, { mensajes: [], dlq: [], suscripciones: new Set() });
  }
  return colas.get(nombre);
}

function encolar(nombreCola, sobre) {
  const cola = obtenerCola(nombreCola);
  const mensaje = {
    id: randomUUID(),
    cola: nombreCola,
    tipo: sobre.tipo,
    datos: sobre.datos ?? {},
    correlationId: sobre.correlationId ?? null,
    creadoEn: new Date().toISOString(),
    entregas: 0,
    visibleDesde: 0,       // timestamp; 0 = disponible ya
    arrendadoPor: null,
  };
  cola.mensajes.push(mensaje);
  metricas.publicados += 1;
  return mensaje;
}

const rutas = [
  /* --------------------------------------------------------------- */
  /* Publisher-Subscriber: publicar en un topico hace fan-out          */
  /* --------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/topicos/:topico/publicar',
    manejador: ({ parametros, cuerpo, correlationId }) => {
      const { topico } = parametros;
      if (!cuerpo.tipo) throw new ErrorHttp(400, 'Falta el campo "tipo" del evento');

      const destinos = [...colas.entries()]
        .filter(([, cola]) => cola.suscripciones.has(topico))
        .map(([nombre]) => nombre);

      const entregados = destinos.map((nombreCola) =>
        encolar(nombreCola, { ...cuerpo, correlationId }).id);

      log.info('evento publicado', {
        correlationId, topico, tipo: cuerpo.tipo, colas: destinos.length,
      });

      // Si nadie escucha, el evento no falla: el publicador no debe saberlo.
      return conEstado(202, { topico, entregadoA: destinos, mensajes: entregados });
    },
  },

  /* --------------------------------------------------------------- */
  /* Suscripcion de una cola a un topico                               */
  /* --------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/colas/:cola/suscripciones',
    manejador: ({ parametros, cuerpo }) => {
      if (!cuerpo.topico) throw new ErrorHttp(400, 'Falta el campo "topico"');
      const cola = obtenerCola(parametros.cola);
      cola.suscripciones.add(cuerpo.topico);
      log.info('suscripcion registrada', { cola: parametros.cola, topico: cuerpo.topico });
      return conEstado(201, { cola: parametros.cola, topicos: [...cola.suscripciones] });
    },
  },

  /* --------------------------------------------------------------- */
  /* Envio directo a una cola (Queue-Based Load Leveling)              */
  /* --------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/colas/:cola/mensajes',
    manejador: ({ parametros, cuerpo, correlationId }) => {
      const mensaje = encolar(parametros.cola, { ...cuerpo, correlationId });
      return conEstado(202, { id: mensaje.id, cola: mensaje.cola });
    },
  },

  /* --------------------------------------------------------------- */
  /* Competing Consumers: arrendar mensajes                            */
  /* --------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/colas/:cola/arrendamientos',
    manejador: ({ parametros, cuerpo }) => {
      const cola = obtenerCola(parametros.cola);
      const cantidad = Math.min(Number(cuerpo.cantidad ?? 1), 10);
      const consumidor = cuerpo.consumidor ?? 'anonimo';
      const ahora = Date.now();

      const arrendados = [];
      for (const mensaje of cola.mensajes) {
        if (arrendados.length >= cantidad) break;
        if (mensaje.visibleDesde > ahora) continue;  // ya lo tiene otro consumidor
        mensaje.visibleDesde = ahora + VISIBILIDAD_MS;
        mensaje.arrendadoPor = consumidor;
        mensaje.entregas += 1;
        metricas.entregados += 1;
        arrendados.push({
          id: mensaje.id,
          tipo: mensaje.tipo,
          datos: mensaje.datos,
          correlationId: mensaje.correlationId,
          entregas: mensaje.entregas,
        });
      }
      return { mensajes: arrendados, pendientes: cola.mensajes.length };
    },
  },

  /* --------------------------------------------------------------- */
  /* Confirmacion (ack): el mensaje desaparece de la cola              */
  /* --------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/colas/:cola/mensajes/:id/confirmar',
    manejador: ({ parametros }) => {
      const cola = obtenerCola(parametros.cola);
      const indice = cola.mensajes.findIndex((m) => m.id === parametros.id);
      if (indice === -1) throw new ErrorHttp(404, 'El mensaje no existe o ya fue confirmado');
      cola.mensajes.splice(indice, 1);
      metricas.confirmados += 1;
      return { confirmado: parametros.id, pendientes: cola.mensajes.length };
    },
  },

  /* --------------------------------------------------------------- */
  /* Rechazo (nack): reencolar o mandar a la Dead Letter Queue         */
  /* --------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/colas/:cola/mensajes/:id/rechazar',
    manejador: ({ parametros, cuerpo }) => {
      const cola = obtenerCola(parametros.cola);
      const indice = cola.mensajes.findIndex((m) => m.id === parametros.id);
      if (indice === -1) throw new ErrorHttp(404, 'El mensaje no existe');
      const mensaje = cola.mensajes[indice];

      if (mensaje.entregas >= MAX_ENTREGAS) {
        cola.mensajes.splice(indice, 1);
        cola.dlq.push({ ...mensaje, motivo: cuerpo.motivo ?? 'sin detalle', movidoEn: new Date().toISOString() });
        metricas.aDlq += 1;
        log.error('mensaje enviado a la DLQ', {
          correlationId: mensaje.correlationId, id: mensaje.id, tipo: mensaje.tipo, entregas: mensaje.entregas,
        });
        return { resultado: 'dead-letter', id: mensaje.id };
      }

      mensaje.visibleDesde = 0;  // vuelve a estar disponible de inmediato
      mensaje.arrendadoPor = null;
      metricas.reencolados += 1;
      return { resultado: 'reencolado', id: mensaje.id, entregas: mensaje.entregas };
    },
  },

  /* --------------------------------------------------------------- */
  /* Observabilidad                                                    */
  /* --------------------------------------------------------------- */
  {
    metodo: 'GET',
    ruta: '/colas',
    manejador: () => ({
      metricas,
      colas: [...colas.entries()].map(([nombre, cola]) => ({
        nombre,
        pendientes: cola.mensajes.length,
        enVuelo: cola.mensajes.filter((m) => m.visibleDesde > Date.now()).length,
        dlq: cola.dlq.length,
        topicos: [...cola.suscripciones],
      })),
    }),
  },
  {
    metodo: 'GET',
    ruta: '/colas/:cola/dlq',
    manejador: ({ parametros }) => ({ cola: parametros.cola, mensajes: obtenerCola(parametros.cola).dlq }),
  },
];

crearServidor({
  nombre: 'broker',
  puerto: config.puertoDe('broker'),
  rutas,
  sondaSalud: () => ({
    ok: true,
    detalle: { colas: colas.size, pendientesTotales: [...colas.values()].reduce((a, c) => a + c.mensajes.length, 0) },
  }),
});
