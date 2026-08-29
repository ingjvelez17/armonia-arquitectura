/**
 * Arranca los seis microservicios en un solo comando (`npm start`).
 *
 * En la nube CADA servicio es un contenedor independiente con su propio ciclo
 * de vida; este lanzador existe unicamente para la comodidad del desarrollo
 * local y de la demostracion en video. El orden importa: el broker primero,
 * porque catalogo y notificaciones se suscriben a el al arrancar.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVICIOS = [
  { nombre: 'broker', ruta: 'services/broker/index.js', puerto: config.puertos.broker },
  { nombre: 'catalogo', ruta: 'services/catalogo/index.js', puerto: config.puertos.catalogo },
  { nombre: 'pagos', ruta: 'services/pagos/index.js', puerto: config.puertos.pagos },
  { nombre: 'reservas', ruta: 'services/reservas/index.js', puerto: config.puertos.reservas },
  { nombre: 'notificaciones', ruta: 'services/notificaciones/index.js', puerto: config.puertos.notificaciones },
  { nombre: 'gateway', ruta: 'services/gateway/index.js', puerto: config.puertos.gateway },
];

const procesos = [];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n  ARMONIA S.A.S. - plataforma de boleteria en la nube');
console.log('  Levantando la malla de microservicios...\n');

for (const servicio of SERVICIOS) {
  const hijo = spawn(process.execPath, [path.join(RAIZ, servicio.ruta)], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  hijo.on('exit', (codigo) => {
    if (codigo !== 0 && codigo !== null) {
      console.error(`\n  [!] El servicio "${servicio.nombre}" termino con codigo ${codigo}\n`);
    }
  });
  procesos.push({ ...servicio, proceso: hijo });
  await esperar(350); // margen para que el broker acepte las suscripciones
}

await esperar(900);
console.log('\n  ---------------------------------------------------------------');
console.log(`  Panel de demostracion : http://127.0.0.1:${config.puertos.gateway}`);
console.log(`  Salud de la malla     : http://127.0.0.1:${config.puertos.gateway}/api/salud`);
console.log(`  Diagnostico completo  : http://127.0.0.1:${config.puertos.gateway}/api/panel`);
console.log('  Clave de API de demo  : demo-armonia-2026');
console.log('  ---------------------------------------------------------------');
console.log('  Ctrl+C para detener toda la malla\n');

const apagarTodo = () => {
  console.log('\n  Deteniendo la malla...');
  for (const { proceso } of procesos) proceso.kill('SIGTERM');
  setTimeout(() => process.exit(0), 800);
};

process.on('SIGINT', apagarTodo);
process.on('SIGTERM', apagarTodo);
