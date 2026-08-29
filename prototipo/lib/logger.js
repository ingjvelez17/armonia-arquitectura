/**
 * Registro estructurado en JSON con propagacion de "correlation id".
 *
 * Patron: Distributed Tracing / Correlation Identifier. Cada peticion que
 * entra por el API Gateway recibe un identificador unico que viaja en la
 * cabecera X-Correlation-Id por toda la cadena de servicios. Sin esto es
 * imposible depurar un sistema distribuido: los logs quedan sueltos y no se
 * puede reconstruir el recorrido de una transaccion.
 */

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };
const NIVEL_MINIMO = NIVELES[process.env.LOG_LEVEL ?? 'info'] ?? 20;

const COLORES = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  reset: '\u001b[0m',
};

export function crearLogger(servicio) {
  const emitir = (nivel, mensaje, datos = {}) => {
    if (NIVELES[nivel] < NIVEL_MINIMO) return;
    const registro = {
      ts: new Date().toISOString(),
      nivel,
      servicio,
      mensaje,
      ...datos,
    };
    if (process.env.LOG_FORMAT === 'json') {
      process.stdout.write(JSON.stringify(registro) + '\n');
      return;
    }
    const cid = datos.correlationId ? ` [${String(datos.correlationId).slice(0, 8)}]` : '';
    const extra = { ...datos };
    delete extra.correlationId;
    const cola = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
    process.stdout.write(
      `${COLORES[nivel]}${nivel.toUpperCase().padEnd(5)}${COLORES.reset} ` +
      `${servicio.padEnd(14)}${cid} ${mensaje}${cola}\n`
    );
  };

  return {
    debug: (m, d) => emitir('debug', m, d),
    info: (m, d) => emitir('info', m, d),
    warn: (m, d) => emitir('warn', m, d),
    error: (m, d) => emitir('error', m, d),
  };
}

export default crearLogger;
