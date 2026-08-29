/**
 * Adapter Pattern (GoF, 1994) para pasarelas de pago.
 *
 * El problema real: en Colombia una plataforma de boleteria debe integrar al
 * menos tarjeta de credito, PSE (debito bancario) y billeteras como Nequi o
 * Daviplata. Cada proveedor expone una API distinta: nombres de campo
 * distintos, unidades distintas (centavos vs. pesos), codigos de respuesta
 * distintos. Si el servicio de pagos habla directamente con cada uno, su
 * logica queda contaminada con los detalles de tres proveedores y cambiar de
 * proveedor obliga a reescribirlo.
 *
 * El adaptador traduce cada API externa a UNA interfaz interna
 * (`autorizar` / `reversar`). El nucleo de pagos solo conoce esa interfaz.
 *
 * Se simulan aqui los tres SDK "externos" con sus rarezas de verdad, para que
 * el trabajo del adaptador sea visible y no un envoltorio vacio.
 */

import { randomUUID } from 'node:crypto';
import { dormir } from '../../lib/resiliencia.js';

/* ==================================================================== */
/* SDK externos simulados (codigo "de terceros", no se puede modificar)  */
/* ==================================================================== */

const sdkTarjeta = {
  /** Trabaja en CENTAVOS y devuelve { status: 'APPROVED' | 'DECLINED', auth_code } */
  async charge({ amount_cents, card_holder, idempotency_key }) {
    await dormir(60 + Math.random() * 90);
    if (amount_cents <= 0) return { status: 'DECLINED', reason: 'INVALID_AMOUNT' };
    return { status: 'APPROVED', auth_code: `TC-${randomUUID().slice(0, 10)}`, holder: card_holder, idempotency_key };
  },
  async refund({ auth_code }) {
    await dormir(50);
    return { status: 'REFUNDED', auth_code };
  },
};

const sdkPSE = {
  /** Trabaja en PESOS enteros y devuelve { codigoRespuesta: 0|1, cus } */
  async iniciarTransaccion({ valor, nombreCliente }) {
    await dormir(120 + Math.random() * 140); // PSE es notoriamente mas lento
    if (valor > 20_000_000) return { codigoRespuesta: 1, mensaje: 'SUPERA_CUPO_DIARIO' };
    return { codigoRespuesta: 0, cus: `PSE${Date.now()}${Math.floor(Math.random() * 999)}`, titular: nombreCliente };
  },
  async anularTransaccion({ cus }) {
    await dormir(90);
    return { codigoRespuesta: 0, cus };
  },
};

const sdkBilletera = {
  /** Trabaja con strings y devuelve { ok: boolean, ref: string } */
  async pagar({ monto, telefono }) {
    await dormir(40 + Math.random() * 50);
    if (!telefono) return { ok: false, error: 'TELEFONO_REQUERIDO' };
    return { ok: true, ref: `NQ-${randomUUID().slice(0, 8)}`, monto: String(monto) };
  },
  async devolver({ ref }) {
    await dormir(40);
    return { ok: true, ref };
  },
};

/* ==================================================================== */
/* Interfaz interna comun                                                */
/* ==================================================================== */

/**
 * @typedef {object} ResultadoAutorizacion
 * @property {boolean} aprobado
 * @property {string}  codigoAutorizacion
 * @property {string}  pasarela
 * @property {string=} motivoRechazo
 */

export class AdaptadorDePasarela {
  get nombre() { throw new Error('Cada adaptador debe declarar su nombre'); }
  /** @returns {Promise<ResultadoAutorizacion>} */
  async autorizar() { throw new Error('Sin implementar'); }
  async reversar() { throw new Error('Sin implementar'); }
}

/* ==================================================================== */
/* Adaptadores concretos                                                 */
/* ==================================================================== */

export class AdaptadorTarjeta extends AdaptadorDePasarela {
  get nombre() { return 'tarjeta'; }

  async autorizar({ montoCOP, cliente, claveIdempotencia }) {
    // Traduccion: pesos -> centavos, y nombres de campo del proveedor.
    const respuesta = await sdkTarjeta.charge({
      amount_cents: Math.round(montoCOP * 100),
      card_holder: cliente,
      idempotency_key: claveIdempotencia,
    });
    return {
      aprobado: respuesta.status === 'APPROVED',
      codigoAutorizacion: respuesta.auth_code ?? null,
      pasarela: this.nombre,
      motivoRechazo: respuesta.reason ?? null,
    };
  }

  async reversar({ codigoAutorizacion }) {
    const r = await sdkTarjeta.refund({ auth_code: codigoAutorizacion });
    return { reversado: r.status === 'REFUNDED', pasarela: this.nombre };
  }
}

export class AdaptadorPSE extends AdaptadorDePasarela {
  get nombre() { return 'pse'; }

  async autorizar({ montoCOP, cliente }) {
    // Traduccion: codigoRespuesta numerico -> booleano; `cus` -> codigo comun.
    const respuesta = await sdkPSE.iniciarTransaccion({ valor: Math.round(montoCOP), nombreCliente: cliente });
    return {
      aprobado: respuesta.codigoRespuesta === 0,
      codigoAutorizacion: respuesta.cus ?? null,
      pasarela: this.nombre,
      motivoRechazo: respuesta.mensaje ?? null,
    };
  }

  async reversar({ codigoAutorizacion }) {
    const r = await sdkPSE.anularTransaccion({ cus: codigoAutorizacion });
    return { reversado: r.codigoRespuesta === 0, pasarela: this.nombre };
  }
}

export class AdaptadorBilletera extends AdaptadorDePasarela {
  get nombre() { return 'billetera'; }

  async autorizar({ montoCOP, cliente, telefono = '3000000000' }) {
    const respuesta = await sdkBilletera.pagar({ monto: montoCOP, telefono });
    return {
      aprobado: respuesta.ok === true,
      codigoAutorizacion: respuesta.ref ?? null,
      pasarela: this.nombre,
      motivoRechazo: respuesta.error ?? null,
    };
  }

  async reversar({ codigoAutorizacion }) {
    const r = await sdkBilletera.devolver({ ref: codigoAutorizacion });
    return { reversado: r.ok === true, pasarela: this.nombre };
  }
}

/* ==================================================================== */
/* Registro + Factory Method                                             */
/* ==================================================================== */

const ADAPTADORES = {
  tarjeta: new AdaptadorTarjeta(),
  pse: new AdaptadorPSE(),
  billetera: new AdaptadorBilletera(),
};

export function obtenerAdaptador(medioDePago) {
  const adaptador = ADAPTADORES[medioDePago];
  if (!adaptador) {
    const error = new Error(`Medio de pago no soportado: "${medioDePago}"`);
    error.estado = 400;
    throw error;
  }
  return adaptador;
}

export const MEDIOS_DE_PAGO = Object.keys(ADAPTADORES);
