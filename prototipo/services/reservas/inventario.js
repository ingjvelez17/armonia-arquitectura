/**
 * Inventario AUTORITATIVO de boleteria (Database per Service).
 *
 * Nota de modelado: la capacidad aparece tambien en el servicio de catalogo,
 * pero con otro proposito. En catalogo es un dato de PRESENTACION (para pintar
 * el mapa del recinto); aqui es el dato TRANSACCIONAL contra el que se decide
 * si una venta procede. Es duplicacion deliberada: cada servicio es dueno de
 * su copia y ninguno consulta la base del otro. Ver ADR-003.
 */

export const INVENTARIO_SEMILLA = [
  { id: 'EVT-001:PLA', eventoId: 'EVT-001', localidad: 'PLA', capacidad: 400, vendidas: 0, reservadas: 0 },
  { id: 'EVT-001:BAL', eventoId: 'EVT-001', localidad: 'BAL', capacidad: 600, vendidas: 0, reservadas: 0 },
  { id: 'EVT-001:GEN', eventoId: 'EVT-001', localidad: 'GEN', capacidad: 1200, vendidas: 0, reservadas: 0 },

  { id: 'EVT-002:VIP', eventoId: 'EVT-002', localidad: 'VIP', capacidad: 900, vendidas: 0, reservadas: 0 },
  { id: 'EVT-002:PRE', eventoId: 'EVT-002', localidad: 'PRE', capacidad: 3500, vendidas: 0, reservadas: 0 },
  { id: 'EVT-002:GEN', eventoId: 'EVT-002', localidad: 'GEN', capacidad: 18000, vendidas: 0, reservadas: 0 },

  { id: 'EVT-003:PAL', eventoId: 'EVT-003', localidad: 'PAL', capacidad: 250, vendidas: 0, reservadas: 0 },
  { id: 'EVT-003:GEN', eventoId: 'EVT-003', localidad: 'GEN', capacidad: 4000, vendidas: 0, reservadas: 0 },

  { id: 'EVT-004:GEN', eventoId: 'EVT-004', localidad: 'GEN', capacidad: 25000, vendidas: 0, reservadas: 0 },
];

/** Localidad de demostracion casi agotada, para probar el camino de "sin cupo". */
export const INVENTARIO_ESCASO = {
  id: 'EVT-003:PAL', eventoId: 'EVT-003', localidad: 'PAL', capacidad: 250, vendidas: 246, reservadas: 0,
};
