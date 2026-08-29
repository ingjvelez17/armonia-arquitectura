/**
 * Patrón: External Configuration Store + Singleton (GoF).
 *
 * Toda la configuracion de la malla de servicios vive en UN solo lugar y se
 * resuelve por variables de entorno. Esto permite que el mismo artefacto
 * (imagen de contenedor) se despliegue en local, staging y produccion sin
 * recompilar: solo cambia el entorno. Es el principio de "build once,
 * deploy anywhere" propio de las aplicaciones de doce factores.
 */

const env = (clave, porDefecto) => process.env[clave] ?? porDefecto;

class ConfiguracionGlobal {
  static #instancia = null;

  /** Punto de acceso global del Singleton. */
  static obtener() {
    if (!ConfiguracionGlobal.#instancia) {
      ConfiguracionGlobal.#instancia = new ConfiguracionGlobal();
    }
    return ConfiguracionGlobal.#instancia;
  }

  constructor() {
    if (ConfiguracionGlobal.#instancia) {
      throw new Error('ConfiguracionGlobal es un Singleton: use ConfiguracionGlobal.obtener()');
    }

    this.entorno = env('NODE_ENV', 'development');
    this.host = env('HOST', '127.0.0.1');

    /** Puertos de cada servicio (Service Registry estatico). */
    this.puertos = {
      gateway: Number(env('PUERTO_GATEWAY', 8080)),
      catalogo: Number(env('PUERTO_CATALOGO', 8081)),
      reservas: Number(env('PUERTO_RESERVAS', 8082)),
      pagos: Number(env('PUERTO_PAGOS', 8083)),
      notificaciones: Number(env('PUERTO_NOTIFICACIONES', 8084)),
      broker: Number(env('PUERTO_BROKER', 8085)),
    };

    /**
     * URLs internas. En la nube estas variables se inyectan con el DNS del
     * proveedor. Render, en particular, resuelve `fromService.property:
     * hostport` como "nombre-servicio:puerto" SIN esquema (asi lo documenta:
     * "Use this value to connect to the service over the private network").
     * Por eso se antepone "http://" solo si el valor no trae ya un esquema:
     * el valor por defecto de desarrollo local ya lo incluye y no se toca.
     */
    const conEsquema = (valor) => (/^https?:\/\//i.test(valor) ? valor : `http://${valor}`);
    this.servicios = {
      catalogo: conEsquema(env('URL_CATALOGO', `http://${this.host}:${this.puertos.catalogo}`)),
      reservas: conEsquema(env('URL_RESERVAS', `http://${this.host}:${this.puertos.reservas}`)),
      pagos: conEsquema(env('URL_PAGOS', `http://${this.host}:${this.puertos.pagos}`)),
      notificaciones: conEsquema(env('URL_NOTIFICACIONES', `http://${this.host}:${this.puertos.notificaciones}`)),
      broker: conEsquema(env('URL_BROKER', `http://${this.host}:${this.puertos.broker}`)),
    };

    /** Parametros de resiliencia (Retry, Circuit Breaker, Throttling). */
    this.resiliencia = {
      reintentosMaximos: Number(env('REINTENTOS_MAXIMOS', 3)),
      esperaBaseMs: Number(env('ESPERA_BASE_MS', 120)),
      timeoutMs: Number(env('TIMEOUT_MS', 2500)),
      umbralFallosCircuito: Number(env('UMBRAL_FALLOS_CIRCUITO', 4)),
      tiempoAperturaCircuitoMs: Number(env('TIEMPO_APERTURA_MS', 5000)),
      limitePeticionesPorMinuto: Number(env('LIMITE_RPM', 300)),
    };

    /** Parametros de negocio. */
    this.negocio = {
      ttlCacheSegundos: Number(env('TTL_CACHE_S', 30)),
      ttlReservaSegundos: Number(env('TTL_RESERVA_S', 300)),
      maxSillasPorCompra: Number(env('MAX_SILLAS', 6)),
      /** Probabilidad de fallo simulada en la pasarela de pagos (0 a 1). */
      tasaFalloPagos: Number(env('TASA_FALLO_PAGOS', 0.25)),
      latenciaBaseDatosMs: Number(env('LATENCIA_BD_MS', 180)),
    };

    /**
     * Los PaaS (Render, Heroku, Cloud Run, App Service) inyectan el puerto de
     * escucha en la variable PORT y esperan que el proceso la respete. Se
     * consulta primero PORT y solo si no existe se usa el puerto fijo del
     * mapa anterior, que es el que se usa en desarrollo local.
     */
    this.puertoDe = (servicio) => Number(env('PORT', 0)) || this.puertos[servicio];

    Object.freeze(this.puertos);
    Object.freeze(this.servicios);
    Object.freeze(this.resiliencia);
    Object.freeze(this.negocio);
    Object.freeze(this);
  }
}

export const config = ConfiguracionGlobal.obtener();
export default config;
