/**
 * Cache-Aside Pattern (tambien llamado Lazy Loading).
 *
 * El servicio consulta primero la cache; si el dato no esta ("miss"), lo lee
 * del almacen lento, lo guarda en cache con un TTL y lo devuelve. En la nube
 * este componente se sustituye por Redis / Azure Cache for Redis / ElastiCache
 * sin tocar la logica de negocio: la interfaz es la misma.
 *
 * Se implementa ademas mitigacion de "cache stampede": si N peticiones piden
 * la misma clave ausente a la vez, solo UNA va al origen y las demas esperan
 * esa misma promesa. Sin esto, un pico de trafico sobre un evento popular
 * dispararia miles de consultas identicas contra la base de datos.
 */

export class CacheEnMemoria {
  constructor({ ttlSegundos = 30, tamanoMaximo = 1000 } = {}) {
    this.ttlMs = ttlSegundos * 1000;
    this.tamanoMaximo = tamanoMaximo;
    this.almacen = new Map(); // clave -> { valor, expiraEn }
    this.enVuelo = new Map(); // clave -> Promise (anti-estampida)
    this.estadisticas = { aciertos: 0, fallos: 0, invalidaciones: 0, desalojos: 0 };
  }

  #estaVigente(entrada) {
    return entrada && entrada.expiraEn > Date.now();
  }

  obtener(clave) {
    const entrada = this.almacen.get(clave);
    if (this.#estaVigente(entrada)) {
      this.estadisticas.aciertos += 1;
      return entrada.valor;
    }
    if (entrada) this.almacen.delete(clave);
    this.estadisticas.fallos += 1;
    return undefined;
  }

  guardar(clave, valor, ttlSegundos) {
    // Politica de desalojo simple (FIFO) para acotar la memoria.
    if (this.almacen.size >= this.tamanoMaximo) {
      const masAntigua = this.almacen.keys().next().value;
      this.almacen.delete(masAntigua);
      this.estadisticas.desalojos += 1;
    }
    this.almacen.set(clave, {
      valor,
      expiraEn: Date.now() + (ttlSegundos ? ttlSegundos * 1000 : this.ttlMs),
    });
    return valor;
  }

  /** Invalidacion explicita: se llama cuando el dato de origen cambia. */
  invalidar(clave) {
    this.estadisticas.invalidaciones += 1;
    return this.almacen.delete(clave);
  }

  invalidarPorPrefijo(prefijo) {
    let borradas = 0;
    for (const clave of this.almacen.keys()) {
      if (clave.startsWith(prefijo)) {
        this.almacen.delete(clave);
        borradas += 1;
      }
    }
    this.estadisticas.invalidaciones += borradas;
    return borradas;
  }

  /**
   * Núcleo del patron: resuelve la clave desde cache o desde el origen.
   * @param {string} clave
   * @param {Function} cargarDelOrigen funcion asincrona que consulta el almacen lento
   */
  async resolver(clave, cargarDelOrigen, ttlSegundos) {
    const enCache = this.obtener(clave);
    if (enCache !== undefined) return { valor: enCache, desdeCache: true };

    // Anti-estampida: reutiliza la carga que ya esta en curso.
    if (this.enVuelo.has(clave)) {
      return { valor: await this.enVuelo.get(clave), desdeCache: false, coalescida: true };
    }

    const promesa = (async () => {
      const valor = await cargarDelOrigen();
      this.guardar(clave, valor, ttlSegundos);
      return valor;
    })();

    this.enVuelo.set(clave, promesa);
    try {
      const valor = await promesa;
      return { valor, desdeCache: false };
    } finally {
      this.enVuelo.delete(clave);
    }
  }

  instantanea() {
    const total = this.estadisticas.aciertos + this.estadisticas.fallos;
    return {
      entradas: this.almacen.size,
      ...this.estadisticas,
      tasaAciertos: total === 0 ? 0 : Number((this.estadisticas.aciertos / total).toFixed(3)),
    };
  }
}
