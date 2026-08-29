/**
 * Cliente del bus de eventos (fachada sobre el broker).
 *
 * Patrones: Publisher-Subscriber + Competing Consumers + Observer (GoF).
 *
 * `Publicador` se usa desde el lado que emite eventos de dominio.
 * `Consumidor` implementa el bucle de arrendar -> procesar -> confirmar/rechazar,
 * que es exactamente como trabaja un worker contra SQS o Service Bus.
 */

import { ClienteServicio } from './cliente-servicio.js';
import { config } from './config.js';
import { dormir } from './resiliencia.js';

export class Publicador {
  constructor(log) {
    this.cliente = new ClienteServicio('broker', config.servicios.broker, log);
    this.log = log;
  }

  /**
   * Publica un evento de dominio. Nunca lanza excepcion hacia el negocio:
   * si el broker esta caido, la operacion principal (p. ej. confirmar una
   * reserva) NO debe fallar por no poder notificar. Es degradacion elegante.
   */
  async publicar(topico, tipo, datos, correlationId) {
    try {
      return await this.cliente.post(`/topicos/${topico}/publicar`, { tipo, datos }, { correlationId });
    } catch (error) {
      this.log.error('no se pudo publicar el evento; el flujo principal continua', {
        correlationId, topico, tipo, causa: error.message,
      });
      return { publicado: false, causa: error.message };
    }
  }
}

export class Consumidor {
  /**
   * @param {object} opciones
   * @param {string} opciones.cola        Cola de la que se lee.
   * @param {string} opciones.identidad   Nombre del trabajador (para trazas).
   * @param {string[]} opciones.topicos   Topicos a los que se suscribe la cola.
   * @param {Function} opciones.manejar   async (mensaje) => void ; si lanza, se rechaza.
   * @param {number} [opciones.intervaloMs] Espera cuando la cola esta vacia.
   */
  constructor({ cola, identidad, topicos = [], manejar, intervaloMs = 400, log }) {
    this.cola = cola;
    this.identidad = identidad;
    this.topicos = topicos;
    this.manejar = manejar;
    this.intervaloMs = intervaloMs;
    this.log = log;
    this.cliente = new ClienteServicio('broker', config.servicios.broker, log);
    this.activo = false;
    this.procesados = 0;
    this.fallidos = 0;
  }

  async suscribir() {
    for (const topico of this.topicos) {
      await this.cliente.post(`/colas/${this.cola}/suscripciones`, { topico });
    }
  }

  async iniciar() {
    this.activo = true;
    this.log.info('consumidor iniciado', { cola: this.cola, trabajador: this.identidad });
    while (this.activo) {
      try {
        const { mensajes } = await this.cliente.post(
          `/colas/${this.cola}/arrendamientos`,
          { consumidor: this.identidad, cantidad: 5 },
        );

        if (!mensajes.length) {
          await dormir(this.intervaloMs);
          continue;
        }

        for (const mensaje of mensajes) {
          try {
            await this.manejar(mensaje);
            await this.cliente.post(`/colas/${this.cola}/mensajes/${mensaje.id}/confirmar`, {});
            this.procesados += 1;
          } catch (error) {
            this.fallidos += 1;
            this.log.warn('mensaje rechazado, volvera a la cola', {
              correlationId: mensaje.correlationId, id: mensaje.id, causa: error.message,
            });
            await this.cliente.post(
              `/colas/${this.cola}/mensajes/${mensaje.id}/rechazar`,
              { motivo: error.message },
            );
          }
        }
      } catch (error) {
        // El broker no responde: se espera y se reintenta. El worker no muere.
        this.log.error('el bucle del consumidor fallo, reintentando', { causa: error.message });
        await dormir(1000);
      }
    }
  }

  detener() {
    this.activo = false;
  }

  instantanea() {
    return { trabajador: this.identidad, cola: this.cola, procesados: this.procesados, fallidos: this.fallidos };
  }
}
