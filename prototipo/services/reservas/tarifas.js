/**
 * Strategy Pattern (GoF, 1994) aplicado al calculo de tarifas.
 *
 * El problema: Armonia vende con reglas de precio que cambian por campana
 * (estudiantes, club de fans, preventa, precio dinamico por ocupacion). Si eso
 * se resuelve con un `if/else` gigante dentro del servicio de reservas, cada
 * campana nueva obliga a tocar y volver a desplegar el nucleo transaccional:
 * se viola el principio abierto/cerrado y sube el riesgo de cada release.
 *
 * Con Strategy cada politica es una clase independiente que cumple el mismo
 * contrato `calcular(contexto)`. Agregar una campana = agregar una clase y
 * registrarla. El nucleo no cambia.
 */

/** Contrato comun de todas las politicas de tarifa. */
export class EstrategiaDeTarifa {
  get nombre() { throw new Error('Cada estrategia debe declarar su nombre'); }

  /**
   * @param {object} contexto { precioBaseCOP, cantidad, porcentajeOcupacion }
   * @returns {{ subtotalCOP:number, descuentoCOP:number, recargoCOP:number, totalCOP:number, detalle:string }}
   */
  calcular() { throw new Error('Cada estrategia debe implementar calcular()'); }

  /** Utilidad compartida: arma el resultado en el formato esperado. */
  _componer({ precioBaseCOP, cantidad, descuento = 0, recargo = 0, detalle }) {
    const subtotalCOP = precioBaseCOP * cantidad;
    const descuentoCOP = Math.round(subtotalCOP * descuento);
    const recargoCOP = Math.round(subtotalCOP * recargo);
    return {
      politica: this.nombre,
      subtotalCOP,
      descuentoCOP,
      recargoCOP,
      totalCOP: subtotalCOP - descuentoCOP + recargoCOP,
      detalle,
    };
  }
}

export class TarifaGeneral extends EstrategiaDeTarifa {
  get nombre() { return 'general'; }
  calcular({ precioBaseCOP, cantidad }) {
    return this._componer({ precioBaseCOP, cantidad, detalle: 'Tarifa plena' });
  }
}

export class TarifaEstudiante extends EstrategiaDeTarifa {
  get nombre() { return 'estudiante'; }
  calcular({ precioBaseCOP, cantidad }) {
    return this._componer({
      precioBaseCOP, cantidad, descuento: 0.30,
      detalle: 'Descuento del 30% con carne estudiantil vigente',
    });
  }
}

export class TarifaClubDeFans extends EstrategiaDeTarifa {
  get nombre() { return 'club'; }
  calcular({ precioBaseCOP, cantidad }) {
    return this._componer({
      precioBaseCOP, cantidad, descuento: 0.15,
      detalle: 'Descuento del 15% para miembros del club',
    });
  }
}

/**
 * Precio dinamico: por encima del 80% de ocupacion se aplica un recargo
 * proporcional. Demuestra que una estrategia puede depender del estado del
 * sistema y no solo del tipo de cliente.
 */
export class TarifaDinamica extends EstrategiaDeTarifa {
  get nombre() { return 'dinamica'; }
  calcular({ precioBaseCOP, cantidad, porcentajeOcupacion = 0 }) {
    const recargo = porcentajeOcupacion > 80
      ? Math.min(0.25, (porcentajeOcupacion - 80) / 100)
      : 0;
    return this._componer({
      precioBaseCOP, cantidad, recargo,
      detalle: recargo > 0
        ? `Recargo por alta demanda (${porcentajeOcupacion}% de ocupacion)`
        : 'Sin recargo por demanda',
    });
  }
}

/**
 * Factory Method: entrega la estrategia adecuada. Si el tipo no existe se
 * devuelve la tarifa general en lugar de fallar: una politica desconocida
 * jamas debe impedir una venta.
 */
const CATALOGO_DE_TARIFAS = {
  general: new TarifaGeneral(),
  estudiante: new TarifaEstudiante(),
  club: new TarifaClubDeFans(),
  dinamica: new TarifaDinamica(),
};

export function obtenerEstrategia(tipo) {
  return CATALOGO_DE_TARIFAS[tipo] ?? CATALOGO_DE_TARIFAS.general;
}

export const TIPOS_DE_TARIFA = Object.keys(CATALOGO_DE_TARIFAS);
