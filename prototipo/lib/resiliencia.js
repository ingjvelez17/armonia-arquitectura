/**
 * Patrones de resiliencia para la nube (Microsoft Azure Architecture Center).
 *
 *   - Retry Pattern            : reintento con espera exponencial y "jitter".
 *   - Circuit Breaker Pattern  : corta el trafico hacia un servicio caido.
 *   - Bulkhead Pattern         : aisla recursos para que un fallo no lo hunda todo.
 *   - Throttling Pattern       : limita la tasa de peticiones (token bucket).
 *   - Timeout                  : ninguna espera es infinita.
 *
 * Retry y Circuit Breaker son complementarios y deben combinarse en ese orden:
 * el reintento resuelve fallos TRANSITORIOS (un paquete perdido), el cortacircuitos
 * evita seguir golpeando un servicio con un fallo PERSISTENTE. Reintentar contra
 * un servicio caido solo amplifica la caida (efecto "retry storm").
 */

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Retry Pattern                                                       */
/* ------------------------------------------------------------------ */

/**
 * Ejecuta `operacion` reintentando ante fallos transitorios.
 * La espera crece exponencialmente (base * 2^intento) y se le suma un
 * componente aleatorio ("jitter") para evitar que miles de clientes
 * reintenten sincronizados y provoquen una estampida.
 */
export const ESPERAS = Object.freeze({
  /**
   * Espera exponencial con jitter. Es la correcta para fallos de RED o de un
   * servicio caido: cada reintento castiga menos al destino y el componente
   * aleatorio evita que miles de clientes reintenten sincronizados.
   */
  exponencial: (intento, base) => Math.round(base * 2 ** (intento - 1) + Math.random() * base),

  /**
   * Espera corta y aleatoria, SIN crecimiento. Es la correcta para conflictos
   * de CONCURRENCIA optimista: el conflicto se resuelve en microsegundos, no
   * hay nada "caido" que necesite descansar. Aplicar backoff exponencial aqui
   * es un error clasico: las esperas se disparan a varios segundos, la
   * peticion supera el timeout del llamante y el sistema se degrada mucho mas
   * que si no se hubiera reintentado (medido en la prueba de carga: 30% de
   * error con backoff exponencial frente a <1% con esta estrategia).
   */
  jitterCorto: (_intento, base) => Math.round(base + Math.random() * base * 1.5),
});

export async function conReintentos(operacion, opciones = {}) {
  const {
    intentosMaximos = 3,
    esperaBaseMs = 120,
    esTransitorio = () => true,
    alReintentar = () => {},
    calcularEspera = ESPERAS.exponencial,
  } = opciones;

  let ultimoError;
  for (let intento = 1; intento <= intentosMaximos; intento += 1) {
    try {
      return await operacion(intento);
    } catch (error) {
      ultimoError = error;
      if (intento === intentosMaximos || !esTransitorio(error)) throw error;
      const espera = calcularEspera(intento, esperaBaseMs);
      alReintentar({ intento, espera, error: error.message });
      await dormir(espera);
    }
  }
  throw ultimoError;
}

/* ------------------------------------------------------------------ */
/* Circuit Breaker Pattern                                             */
/* ------------------------------------------------------------------ */

export const ESTADOS_CIRCUITO = Object.freeze({
  CERRADO: 'CERRADO',        // funcionamiento normal, el trafico pasa
  ABIERTO: 'ABIERTO',        // el destino esta caido, se falla rapido
  SEMIABIERTO: 'SEMIABIERTO', // se deja pasar UNA peticion de prueba
});

export class CortacircuitosAbiertoError extends Error {
  constructor(nombre) {
    super(`Cortacircuitos ABIERTO para "${nombre}": el servicio destino no responde`);
    this.name = 'CortacircuitosAbiertoError';
    this.esCortacircuitos = true;
    this.estado = 503;
  }
}

export class Cortacircuitos {
  /**
   * @param {string} nombre            Recurso protegido (para trazas).
   * @param {number} umbralFallos      Fallos consecutivos que abren el circuito.
   * @param {number} tiempoAperturaMs  Tiempo antes de pasar a SEMIABIERTO.
   */
  constructor(nombre, { umbralFallos = 4, tiempoAperturaMs = 5000, alCambiarEstado = () => {} } = {}) {
    this.nombre = nombre;
    this.umbralFallos = umbralFallos;
    this.tiempoAperturaMs = tiempoAperturaMs;
    this.alCambiarEstado = alCambiarEstado;
    this.estado = ESTADOS_CIRCUITO.CERRADO;
    this.fallosConsecutivos = 0;
    this.abiertoHasta = 0;
    this.estadisticas = { exitos: 0, fallos: 0, rechazos: 0, aperturas: 0 };
  }

  #cambiarA(nuevoEstado) {
    if (this.estado === nuevoEstado) return;
    const anterior = this.estado;
    this.estado = nuevoEstado;
    if (nuevoEstado === ESTADOS_CIRCUITO.ABIERTO) this.estadisticas.aperturas += 1;
    this.alCambiarEstado({ recurso: this.nombre, anterior, nuevo: nuevoEstado });
  }

  /**
   * Ejecuta la operacion protegida.
   * @param {Function} operacion
   * @param {Function|null} respaldo        Plan B (degradacion elegante).
   * @param {Function} cuentaComoFallo      Decide que errores "ensucian" el
   *   circuito. Por defecto todos. Es clave distinguir un fallo de
   *   INFRAESTRUCTURA (el destino no responde) de un rechazo de NEGOCIO
   *   (HTTP 409 "no hay cupo"): el segundo significa que el servicio esta
   *   perfectamente sano, y contarlo abriria el circuito sin motivo.
   */
  async ejecutar(operacion, respaldo = null, cuentaComoFallo = () => true) {
    if (this.estado === ESTADOS_CIRCUITO.ABIERTO) {
      if (Date.now() < this.abiertoHasta) {
        this.estadisticas.rechazos += 1;
        const error = new CortacircuitosAbiertoError(this.nombre);
        if (respaldo) return respaldo(error);
        throw error;
      }
      this.#cambiarA(ESTADOS_CIRCUITO.SEMIABIERTO);
    }

    try {
      const resultado = await operacion();
      this.#registrarExito();
      return resultado;
    } catch (error) {
      if (cuentaComoFallo(error)) this.#registrarFallo();
      else this.#registrarExito();
      if (respaldo) return respaldo(error);
      throw error;
    }
  }

  #registrarExito() {
    this.estadisticas.exitos += 1;
    this.fallosConsecutivos = 0;
    this.#cambiarA(ESTADOS_CIRCUITO.CERRADO);
  }

  #registrarFallo() {
    this.estadisticas.fallos += 1;
    this.fallosConsecutivos += 1;
    if (this.estado === ESTADOS_CIRCUITO.SEMIABIERTO ||
        this.fallosConsecutivos >= this.umbralFallos) {
      this.abiertoHasta = Date.now() + this.tiempoAperturaMs;
      this.#cambiarA(ESTADOS_CIRCUITO.ABIERTO);
    }
  }

  instantanea() {
    return {
      recurso: this.nombre,
      estado: this.estado,
      fallosConsecutivos: this.fallosConsecutivos,
      reabreEnMs: Math.max(0, this.abiertoHasta - Date.now()),
      ...this.estadisticas,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Bulkhead Pattern                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mamparo: limita cuantas operaciones concurrentes puede consumir un
 * destino. Igual que los compartimentos estancos de un barco, si el servicio
 * de pagos se vuelve lento no puede acaparar todo el pool de conexiones y
 * arrastrar tambien al catalogo.
 */
export class Mamparo {
  constructor(nombre, concurrenciaMaxima = 8, colaMaxima = 64) {
    this.nombre = nombre;
    this.concurrenciaMaxima = concurrenciaMaxima;
    this.colaMaxima = colaMaxima;
    this.enEjecucion = 0;
    this.cola = [];
    this.rechazadas = 0;
  }

  async ejecutar(operacion) {
    if (this.enEjecucion >= this.concurrenciaMaxima) {
      if (this.cola.length >= this.colaMaxima) {
        this.rechazadas += 1;
        const error = new Error(`Mamparo "${this.nombre}" saturado: peticion rechazada`);
        error.estado = 503;
        throw error;
      }
      await new Promise((resolver) => this.cola.push(resolver));
    }
    this.enEjecucion += 1;
    try {
      return await operacion();
    } finally {
      this.enEjecucion -= 1;
      const siguiente = this.cola.shift();
      if (siguiente) siguiente();
    }
  }

  instantanea() {
    return {
      recurso: this.nombre,
      enEjecucion: this.enEjecucion,
      enCola: this.cola.length,
      rechazadas: this.rechazadas,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Throttling Pattern (token bucket)                                   */
/* ------------------------------------------------------------------ */

export class LimitadorDeTasa {
  /** @param {number} capacidad Peticiones permitidas por ventana. */
  constructor(capacidad = 600, ventanaMs = 60_000) {
    this.capacidad = capacidad;
    this.ventanaMs = ventanaMs;
    this.cubos = new Map(); // clave (IP o API key) -> { fichas, ultimaRecarga }
  }

  permitir(clave) {
    const ahora = Date.now();
    let cubo = this.cubos.get(clave);
    if (!cubo) {
      cubo = { fichas: this.capacidad, ultimaRecarga: ahora };
      this.cubos.set(clave, cubo);
    }
    // Recarga proporcional al tiempo transcurrido.
    const transcurrido = ahora - cubo.ultimaRecarga;
    const recarga = (transcurrido / this.ventanaMs) * this.capacidad;
    cubo.fichas = Math.min(this.capacidad, cubo.fichas + recarga);
    cubo.ultimaRecarga = ahora;

    if (cubo.fichas < 1) {
      return {
        permitido: false,
        restantes: 0,
        reintentarEnS: Math.max(1, Math.ceil(this.ventanaMs / this.capacidad / 1000)),
      };
    }
    cubo.fichas -= 1;
    return { permitido: true, restantes: Math.floor(cubo.fichas) };
  }
}

/* ------------------------------------------------------------------ */
/* Timeout                                                             */
/* ------------------------------------------------------------------ */

export async function conTiempoLimite(promesa, ms, mensaje = 'Tiempo de espera agotado') {
  let temporizador;
  try {
    return await Promise.race([
      promesa,
      new Promise((_, rechazar) => {
        temporizador = setTimeout(() => {
          const error = new Error(`${mensaje} (${ms} ms)`);
          error.esTimeout = true;
          rechazar(error);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(temporizador);
  }
}
