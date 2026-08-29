/**
 * Repository Pattern (Fowler, 2002) + Database per Service.
 *
 * Cada microservicio posee SU propio almacen y nadie mas lo toca. El
 * repositorio abstrae la persistencia detras de una interfaz de coleccion, de
 * modo que la logica de negocio no sabe si detras hay un Map en memoria,
 * PostgreSQL o Cosmos DB. Cambiar de motor = escribir una subclase nueva.
 *
 * `RepositorioEnMemoria` simula latencia de red/disco para que las pruebas de
 * rendimiento y el patron Cache-Aside tengan sentido observable.
 */

import { dormir } from './resiliencia.js';

export class ConflictoDeConcurrenciaError extends Error {
  constructor(id, versionEsperada, versionReal) {
    super(`Conflicto de concurrencia optimista en "${id}": se esperaba v${versionEsperada} y el almacen tiene v${versionReal}`);
    this.name = 'ConflictoDeConcurrenciaError';
    this.estado = 409;
  }
}

export class RepositorioEnMemoria {
  /**
   * @param {string} nombre
   * @param {number} latenciaMs Latencia simulada del almacen (por operacion).
   */
  constructor(nombre, latenciaMs = 0) {
    this.nombre = nombre;
    this.latenciaMs = latenciaMs;
    this.datos = new Map();
    this.operaciones = 0;
  }

  async #latencia() {
    this.operaciones += 1;
    if (this.latenciaMs > 0) {
      // Latencia con variacion +-30% para parecerse a una red real.
      const variacion = this.latenciaMs * (0.7 + Math.random() * 0.6);
      await dormir(Math.round(variacion));
    }
  }

  async buscarPorId(id) {
    await this.#latencia();
    const entidad = this.datos.get(id);
    return entidad ? structuredClone(entidad) : null;
  }

  async listar(filtro = () => true) {
    await this.#latencia();
    return [...this.datos.values()].filter(filtro).map((e) => structuredClone(e));
  }

  async guardar(entidad) {
    await this.#latencia();
    const copia = structuredClone(entidad);
    copia.version = (this.datos.get(copia.id)?.version ?? 0) + 1;
    copia.actualizadoEn = new Date().toISOString();
    this.datos.set(copia.id, copia);
    return structuredClone(copia);
  }

  /**
   * Concurrencia optimista (Optimistic Offline Lock). Imprescindible cuando
   * miles de compradores pelean por la misma silla: en lugar de bloquear la
   * fila, se verifica que nadie la haya modificado desde que se leyo.
   */
  async guardarConVersion(entidad, versionEsperada) {
    await this.#latencia();
    const actual = this.datos.get(entidad.id);
    const versionReal = actual?.version ?? 0;
    if (versionReal !== versionEsperada) {
      throw new ConflictoDeConcurrenciaError(entidad.id, versionEsperada, versionReal);
    }
    const copia = structuredClone(entidad);
    copia.version = versionReal + 1;
    copia.actualizadoEn = new Date().toISOString();
    this.datos.set(copia.id, copia);
    return structuredClone(copia);
  }

  async eliminar(id) {
    await this.#latencia();
    return this.datos.delete(id);
  }

  /** Carga inicial de datos (seed) sin latencia: solo para el arranque. */
  sembrar(entidades) {
    for (const entidad of entidades) {
      this.datos.set(entidad.id, { ...entidad, version: 1, actualizadoEn: new Date().toISOString() });
    }
    return this;
  }

  get tamano() {
    return this.datos.size;
  }
}
