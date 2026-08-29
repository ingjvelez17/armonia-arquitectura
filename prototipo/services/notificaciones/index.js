/**
 * ============================================================================
 *  SERVICIO DE NOTIFICACIONES  (puerto 8084)
 * ============================================================================
 *
 * Es el consumidor asincrono del sistema. Ninguna venta espera a que se envie
 * un correo: la reserva se confirma, se publica un evento y este servicio lo
 * procesa despues. Ese desacople es lo que permite que la plataforma aguante
 * el pico del "onsale" sin que el proveedor de correo sea un cuello de botella.
 *
 * Patrones aplicados:
 *   - Competing Consumers : dos trabajadores leen de la MISMA cola. Escalar la
 *                           capacidad = arrancar mas trabajadores, sin tocar
 *                           codigo ni coordinar particiones.
 *   - Observer (GoF)      : el despachador notifica a N canales suscritos
 *                           (correo, SMS, push). Agregar WhatsApp manana =
 *                           registrar un observador mas.
 *   - Queue-Based Load Leveling : la cola amortigua el pico de trafico.
 *   - Dead Letter Queue   : un mensaje envenenado no bloquea la cola.
 */

import { crearServidor } from '../../lib/http.js';
import { config } from '../../lib/config.js';
import { crearLogger } from '../../lib/logger.js';
import { Consumidor } from '../../lib/bus.js';
import { dormir } from '../../lib/resiliencia.js';

const log = crearLogger('notificaciones');

/* ==================================================================== */
/* Observer: canales de salida                                           */
/* ==================================================================== */

/** Interfaz del observador. */
class CanalDeNotificacion {
  get nombre() { throw new Error('Cada canal debe declarar su nombre'); }
  /** @returns {Promise<boolean>} true si el canal atiende ese tipo de evento */
  interesadoEn() { return true; }
  async enviar() { throw new Error('Sin implementar'); }
}

class CanalCorreo extends CanalDeNotificacion {
  get nombre() { return 'correo'; }
  async enviar(mensaje) {
    await dormir(30); // simula la llamada al proveedor SMTP/SendGrid
    return {
      canal: this.nombre,
      destino: `${mensaje.datos.cliente ?? 'cliente'}@correo.co`,
      asunto: TITULOS[mensaje.tipo] ?? 'Actualizacion de tu compra',
      cuerpo: redactar(mensaje),
    };
  }
}

class CanalSMS extends CanalDeNotificacion {
  get nombre() { return 'sms'; }
  /** El SMS cuesta dinero: solo se manda en los eventos que le importan al cliente. */
  interesadoEn(tipo) { return tipo === 'reserva.confirmada' || tipo === 'reserva.reembolsada'; }
  async enviar(mensaje) {
    await dormir(20);
    return { canal: this.nombre, destino: '+57 3xx xxx xx xx', cuerpo: redactar(mensaje).slice(0, 140) };
  }
}

class CanalPushApp extends CanalDeNotificacion {
  get nombre() { return 'push'; }
  interesadoEn(tipo) { return tipo !== 'reserva.creada'; }
  async enviar(mensaje) {
    await dormir(10);
    return { canal: this.nombre, destino: 'app-movil', cuerpo: redactar(mensaje) };
  }
}

const TITULOS = {
  'reserva.creada': 'Estamos procesando tu compra',
  'reserva.confirmada': 'Tus boletas estan confirmadas',
  'reserva.cancelada': 'No pudimos completar tu compra',
  'reserva.expirada': 'Tu reserva expiro',
  'reserva.reembolsada': 'Tu reembolso fue procesado',
};

function redactar(mensaje) {
  const d = mensaje.datos;
  const evento = d.nombreEvento ?? d.eventoId;
  switch (mensaje.tipo) {
    case 'reserva.confirmada':
      return `Listo. ${d.cantidad} boleta(s) para "${evento}" (localidad ${d.localidad}). ` +
             `Total: $${Number(d.totalCOP ?? 0).toLocaleString('es-CO')} COP. Reserva ${d.reservaId}.`;
    case 'reserva.cancelada':
      return `Tu compra ${d.reservaId} para "${evento}" no se completo: ${d.motivo ?? 'error en el pago'}. ` +
             'No se realizo ningun cobro y las boletas volvieron a estar disponibles.';
    case 'reserva.expirada':
      return `La reserva ${d.reservaId} expiro por inactividad y las boletas se liberaron.`;
    case 'reserva.reembolsada':
      return `Reembolsamos $${Number(d.totalCOP ?? 0).toLocaleString('es-CO')} COP de la reserva ${d.reservaId}.`;
    default:
      return `Actualizacion de la reserva ${d.reservaId}.`;
  }
}

/** Sujeto observable: mantiene los canales y les difunde cada evento. */
class DespachadorDeNotificaciones {
  constructor() { this.canales = []; }

  registrar(canal) { this.canales.push(canal); return this; }

  async difundir(mensaje) {
    const interesados = this.canales.filter((c) => c.interesadoEn(mensaje.tipo));
    const envios = await Promise.all(interesados.map(async (canal) => {
      try {
        return { ok: true, ...(await canal.enviar(mensaje)) };
      } catch (error) {
        // Un canal caido no debe tumbar a los demas ni reprocesar el mensaje.
        log.error('fallo un canal de notificacion', { canal: canal.nombre, causa: error.message });
        return { ok: false, canal: canal.nombre, error: error.message };
      }
    }));
    return envios;
  }
}

const despachador = new DespachadorDeNotificaciones()
  .registrar(new CanalCorreo())
  .registrar(new CanalSMS())
  .registrar(new CanalPushApp());

/* ==================================================================== */
/* Bandeja de salida (para poder verlo en la demo)                       */
/* ==================================================================== */

const bandeja = [];
const MAX_BANDEJA = 300;
const metricas = { recibidos: 0, enviados: 0, fallidos: 0, porTipo: {} };

async function procesarMensaje(mensaje) {
  metricas.recibidos += 1;
  metricas.porTipo[mensaje.tipo] = (metricas.porTipo[mensaje.tipo] ?? 0) + 1;

  const envios = await despachador.difundir(mensaje);
  metricas.enviados += envios.filter((e) => e.ok).length;
  metricas.fallidos += envios.filter((e) => !e.ok).length;

  bandeja.unshift({
    id: mensaje.id,
    tipo: mensaje.tipo,
    correlationId: mensaje.correlationId,
    reservaId: mensaje.datos.reservaId,
    recibidoEn: new Date().toISOString(),
    envios,
  });
  if (bandeja.length > MAX_BANDEJA) bandeja.length = MAX_BANDEJA;

  log.info('notificaciones despachadas', {
    correlationId: mensaje.correlationId, tipo: mensaje.tipo, canales: envios.length,
  });
}

/* ==================================================================== */
/* Competing Consumers: dos trabajadores sobre la misma cola             */
/* ==================================================================== */

const trabajadores = [1, 2].map((n) => new Consumidor({
  cola: 'notificaciones',
  identidad: `notificador-${n}`,
  topicos: ['reservas'],
  manejar: procesarMensaje,
  intervaloMs: 300,
  log,
}));

const rutas = [
  {
    metodo: 'GET',
    ruta: '/notificaciones',
    manejador: ({ url }) => {
      const limite = Number(url.searchParams.get('limite') ?? 25);
      return { total: bandeja.length, notificaciones: bandeja.slice(0, limite) };
    },
  },
  {
    metodo: 'GET',
    ruta: '/diagnostico',
    manejador: () => ({
      servicio: 'notificaciones',
      metricas,
      canales: despachador.canales.map((c) => c.nombre),
      trabajadores: trabajadores.map((t) => t.instantanea()),
    }),
  },
];

crearServidor({
  nombre: 'notificaciones',
  puerto: config.puertoDe('notificaciones'),
  rutas,
  sondaSalud: () => ({ ok: true, detalle: { enBandeja: bandeja.length, trabajadores: trabajadores.length } }),
});

(async () => {
  try {
    await trabajadores[0].suscribir();
  } catch (error) {
    log.warn('no se pudo suscribir al broker todavia; se reintentara', { causa: error.message });
  }
  trabajadores.forEach((t) => t.iniciar());
})();
