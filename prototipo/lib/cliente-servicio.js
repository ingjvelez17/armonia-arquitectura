/**
 * Ambassador Pattern.
 *
 * Ningun servicio llama a otro con `fetch` "pelado". Toda llamada saliente
 * pasa por este embajador, que concentra en un unico punto:
 *
 *   Timeout  ->  Retry (exponencial + jitter)  ->  Circuit Breaker  ->  Mamparo
 *   + propagacion del Correlation Id
 *   + respaldo (fallback) para degradacion elegante
 *
 * Es exactamente lo que hace un "service mesh" (Istio, Linkerd) con un sidecar,
 * pero implementado en la aplicacion para que sea visible y demostrable.
 */

import { config } from './config.js';
import {
  conReintentos, conTiempoLimite, Cortacircuitos, Mamparo,
} from './resiliencia.js';
import { CABECERA_CORRELACION } from './http.js';

export class ErrorServicioRemoto extends Error {
  constructor(servicio, estado, cuerpo) {
    super(`El servicio "${servicio}" respondio ${estado}: ${JSON.stringify(cuerpo)}`);
    this.name = 'ErrorServicioRemoto';
    this.servicio = servicio;
    this.estado = estado;
    this.cuerpo = cuerpo;
  }
}

/** Un fallo transitorio merece reintento; uno de negocio (4xx) no. */
export function esFalloTransitorio(error) {
  if (error.esCortacircuitos) return false;          // el circuito ya decidio
  if (error.esTimeout) return true;
  if (error.name === 'TypeError') return true;       // conexion rechazada
  if (typeof error.estado === 'number') return error.estado >= 500 || error.estado === 429;
  return true;
}

export class ClienteServicio {
  /**
   * @param {string} nombre     Servicio destino (catalogo, pagos, ...).
   * @param {string} urlBase    URL raiz del destino.
   * @param {object} log        Logger del servicio llamante.
   */
  constructor(nombre, urlBase, log) {
    this.nombre = nombre;
    this.urlBase = urlBase.replace(/\/+$/, '');
    this.log = log;
    this.cortacircuitos = new Cortacircuitos(nombre, {
      umbralFallos: config.resiliencia.umbralFallosCircuito,
      tiempoAperturaMs: config.resiliencia.tiempoAperturaCircuitoMs,
      alCambiarEstado: ({ recurso, anterior, nuevo }) =>
        log.warn('el cortacircuitos cambio de estado', { recurso, anterior, nuevo }),
    });
    this.mamparo = new Mamparo(nombre, 16, 200);
  }

  /**
   * @param {string} metodo     GET | POST | PUT | DELETE
   * @param {string} ruta       /eventos/EVT-001
   * @param {object} opciones   { cuerpo, correlationId, cabeceras, respaldo, sinReintentos }
   */
  async invocar(metodo, ruta, opciones = {}) {
    const {
      cuerpo, correlationId, cabeceras = {}, respaldo = null,
      sinReintentos = false, sinCircuito = false, incluirEstado = false,
    } = opciones;

    const ejecutarLlamada = async (intento = 1) => {
      const peticion = fetch(`${this.urlBase}${ruta}`, {
        method: metodo,
        headers: {
          'content-type': 'application/json',
          [CABECERA_CORRELACION]: correlationId ?? '',
          'x-intento': String(intento),
          ...cabeceras,
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });

      const respuesta = await conTiempoLimite(
        peticion,
        config.resiliencia.timeoutMs,
        `Sin respuesta de "${this.nombre}"`,
      );

      const texto = await respuesta.text();
      const datos = texto ? JSON.parse(texto) : {};
      if (!respuesta.ok) throw new ErrorServicioRemoto(this.nombre, respuesta.status, datos);
      // El gateway necesita el codigo original para no convertir un 201
      // ("creado") o un 200 idempotente en un 200 generico.
      return incluirEstado ? { estado: respuesta.status, datos } : datos;
    };

    const conPoliticaDeReintento = () =>
      sinReintentos
        ? ejecutarLlamada(1)
        : conReintentos(ejecutarLlamada, {
            intentosMaximos: config.resiliencia.reintentosMaximos,
            esperaBaseMs: config.resiliencia.esperaBaseMs,
            esTransitorio: esFalloTransitorio,
            alReintentar: ({ intento, espera, error }) =>
              this.log.warn('reintentando llamada saliente', {
                correlationId, destino: this.nombre, ruta, intento, esperaMs: espera, causa: error,
              }),
          });

    // Las llamadas de observabilidad (salud, diagnostico) esquivan el
    // cortacircuitos a proposito: el panel debe seguir viendo el sistema
    // JUSTO cuando esta roto, que es cuando mas se necesita.
    if (sinCircuito) return this.mamparo.ejecutar(conPoliticaDeReintento);

    // Orden: Mamparo (aisla) -> Cortacircuitos (falla rapido) -> Retry -> Timeout
    return this.mamparo.ejecutar(() =>
      this.cortacircuitos.ejecutar(conPoliticaDeReintento, respaldo, esFalloTransitorio));
  }

  get(ruta, opciones) { return this.invocar('GET', ruta, opciones); }
  post(ruta, cuerpo, opciones = {}) { return this.invocar('POST', ruta, { ...opciones, cuerpo }); }
  put(ruta, cuerpo, opciones = {}) { return this.invocar('PUT', ruta, { ...opciones, cuerpo }); }
  del(ruta, opciones) { return this.invocar('DELETE', ruta, opciones); }

  instantanea() {
    return {
      destino: this.nombre,
      circuito: this.cortacircuitos.instantanea(),
      mamparo: this.mamparo.instantanea(),
    };
  }
}

/** Fabrica de clientes para todos los servicios conocidos (Factory Method). */
export function crearClientes(log, nombres = Object.keys(config.servicios)) {
  const clientes = {};
  for (const nombre of nombres) {
    clientes[nombre] = new ClienteServicio(nombre, config.servicios[nombre], log);
  }
  return clientes;
}
