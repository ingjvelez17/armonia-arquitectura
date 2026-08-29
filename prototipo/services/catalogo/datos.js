/**
 * Datos semilla del catalogo de Armonia S.A.S.
 * En produccion esto vive en la base de datos del servicio de catalogo
 * (Database per Service): ningun otro microservicio la consulta directamente.
 */

export const EVENTOS_SEMILLA = [
  {
    id: 'EVT-001',
    nombre: 'Sinfonica de Colombia: Noche de Gala',
    artista: 'Orquesta Sinfonica Nacional de Colombia',
    genero: 'Clasica',
    ciudad: 'Bogota',
    escenario: 'Teatro Mayor Julio Mario Santo Domingo',
    fecha: '2026-10-17T20:00:00-05:00',
    estado: 'a la venta',
    imagen: 'gala',
    localidades: [
      { codigo: 'PLA', nombre: 'Platea', precioCOP: 320000, capacidad: 400 },
      { codigo: 'BAL', nombre: 'Balcon', precioCOP: 190000, capacidad: 600 },
      { codigo: 'GEN', nombre: 'General', precioCOP: 95000, capacidad: 1200 },
    ],
  },
  {
    id: 'EVT-002',
    nombre: 'Festival Cordillera Sonora',
    artista: 'Cartel de 18 artistas',
    genero: 'Rock / Alternativo',
    ciudad: 'Medellin',
    escenario: 'Estadio Atanasio Girardot',
    fecha: '2026-11-08T15:00:00-05:00',
    estado: 'a la venta',
    imagen: 'festival',
    localidades: [
      { codigo: 'VIP', nombre: 'VIP Frontal', precioCOP: 780000, capacidad: 900 },
      { codigo: 'PRE', nombre: 'Preferencial', precioCOP: 420000, capacidad: 3500 },
      { codigo: 'GEN', nombre: 'General', precioCOP: 210000, capacidad: 18000 },
    ],
  },
  {
    id: 'EVT-003',
    nombre: 'Cumbia Futura en vivo',
    artista: 'Colectivo Cumbia Futura',
    genero: 'Tropical',
    ciudad: 'Barranquilla',
    escenario: 'Parque Cultural del Caribe',
    fecha: '2026-09-27T19:30:00-05:00',
    estado: 'a la venta',
    imagen: 'cumbia',
    localidades: [
      { codigo: 'PAL', nombre: 'Palco', precioCOP: 260000, capacidad: 250 },
      { codigo: 'GEN', nombre: 'General', precioCOP: 85000, capacidad: 4000 },
    ],
  },
  {
    id: 'EVT-004',
    nombre: 'Jazz al Parque: sesion de cierre',
    artista: 'Bogota Jazz Ensemble',
    genero: 'Jazz',
    ciudad: 'Bogota',
    escenario: 'Parque Simon Bolivar',
    fecha: '2026-12-06T17:00:00-05:00',
    estado: 'proximamente',
    imagen: 'jazz',
    localidades: [
      { codigo: 'GEN', nombre: 'General', precioCOP: 0, capacidad: 25000 },
    ],
  },
];
