/**
 * ============================================================================
 *  SERVICIO DE PAGOS  (puerto 8083)
 * ============================================================================
 *
 * Patrones aplicados:
 *   - Adapter            : una interfaz interna para tres pasarelas distintas.
 *   - Idempotent Receiver: la misma clave nunca cobra dos veces (critico: es
 *                          dinero real y el llamante reintenta ante timeouts).
 *   - Anti-Corruption    : los codigos y formatos de cada proveedor no salen
 *                          de la capa de adaptadores.
 *   - Chaos Engineering  : el endpoint /caos inyecta fallos y latencia bajo
 *                          demanda para DEMOSTRAR el cortacircuitos del
 *                          servicio de reservas. Es el servicio "fragil"
 *                          a proposito.
 */

import { randomUUID } from 'node:crypto';
import { crearServidor, ErrorHttp, conEstado, CABECERA_IDEMPOTENCIA } from '../../lib/http.js';
import { config } from '../../lib/config.js';
import { crearLogger } from '../../lib/logger.js';
import { RepositorioEnMemoria } from '../../lib/repositorio.js';
import { dormir } from '../../lib/resiliencia.js';
import { obtenerAdaptador, MEDIOS_DE_PAGO } from './pasarelas.js';

const log = crearLogger('pagos');
const repositorioCobros = new RepositorioEnMemoria('cobros', 10);

/** Idempotent Receiver: clave -> transaccion ya emitida. */
const registroIdempotencia = new Map();

/** Interruptores de caos, manipulables en caliente desde la demo. */
const caos = {
  tasaFallo: config.negocio.tasaFalloPagos, // 0 a 1
  latenciaExtraMs: 0,
  caido: false,
};

const metricas = { intentos: 0, aprobados: 0, rechazados: 0, fallosInyectados: 0, idempotentes: 0, reversos: 0 };

const rutas = [
  /* ---------------------------------------------------------------- */
  /* Autorizacion de cobro                                             */
  /* ---------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/cobros',
    manejador: async ({ peticion, cuerpo, correlationId }) => {
      const claveIdempotencia = peticion.headers[CABECERA_IDEMPOTENCIA];

      // ---- Idempotent Receiver: PRIMERO, antes de tocar la pasarela ----
      if (claveIdempotencia && registroIdempotencia.has(claveIdempotencia)) {
        metricas.idempotentes += 1;
        log.info('cobro duplicado evitado por idempotencia', { correlationId, claveIdempotencia });
        return conEstado(200, { ...registroIdempotencia.get(claveIdempotencia), idempotente: true });
      }

      metricas.intentos += 1;

      // ---- Inyeccion de caos: simula la fragilidad de una pasarela real ----
      if (caos.caido) {
        metricas.fallosInyectados += 1;
        throw new ErrorHttp(503, 'La pasarela de pagos no esta disponible (caos: caido)');
      }
      if (caos.latenciaExtraMs > 0) await dormir(caos.latenciaExtraMs);
      if (Math.random() < caos.tasaFallo) {
        metricas.fallosInyectados += 1;
        log.warn('fallo transitorio inyectado en la pasarela', { correlationId, referencia: cuerpo.referencia });
        throw new ErrorHttp(503, 'Timeout de la red de la pasarela (fallo transitorio simulado)');
      }

      const { referencia, cliente, montoCOP, medioDePago = 'tarjeta' } = cuerpo;
      if (!referencia) throw new ErrorHttp(400, 'Falta la referencia de la compra');
      if (!Number.isFinite(montoCOP) || montoCOP < 0) throw new ErrorHttp(400, 'Monto invalido');

      // ---- Adapter: la misma llamada sirve para tarjeta, PSE o billetera ----
      const adaptador = obtenerAdaptador(medioDePago);
      const resultado = await adaptador.autorizar({ montoCOP, cliente, claveIdempotencia });

      const transaccion = {
        id: `TRX-${randomUUID().slice(0, 8).toUpperCase()}`,
        referencia,
        cliente,
        montoCOP,
        medioDePago,
        pasarela: resultado.pasarela,
        aprobado: resultado.aprobado,
        codigoAutorizacion: resultado.codigoAutorizacion,
        motivoRechazo: resultado.motivoRechazo,
        estado: resultado.aprobado ? 'APROBADO' : 'RECHAZADO',
        creadaEn: new Date().toISOString(),
        correlationId,
      };
      await repositorioCobros.guardar(transaccion);

      if (!resultado.aprobado) {
        metricas.rechazados += 1;
        // 402 (Payment Required): error de negocio, NO transitorio. El
        // ambassador del llamante no debe reintentarlo.
        throw new ErrorHttp(402, `Pago rechazado por la pasarela: ${resultado.motivoRechazo}`, {
          transaccionId: transaccion.id,
        });
      }

      metricas.aprobados += 1;
      const respuesta = {
        transaccionId: transaccion.id,
        referencia,
        montoCOP,
        pasarela: resultado.pasarela,
        codigoAutorizacion: resultado.codigoAutorizacion,
        estado: 'APROBADO',
      };
      if (claveIdempotencia) registroIdempotencia.set(claveIdempotencia, respuesta);

      log.info('cobro aprobado', {
        correlationId, transaccion: transaccion.id, montoCOP, pasarela: resultado.pasarela,
      });
      return conEstado(201, respuesta);
    },
  },

  /* ---------------------------------------------------------------- */
  /* Reverso (transaccion compensatoria)                               */
  /* ---------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/cobros/:id/reverso',
    manejador: async ({ parametros, cuerpo, correlationId }) => {
      const transaccion = await repositorioCobros.buscarPorId(parametros.id);
      if (!transaccion) throw new ErrorHttp(404, `La transaccion "${parametros.id}" no existe`);
      if (transaccion.estado === 'REVERSADO') {
        return { ...transaccion, yaEstabaReversada: true }; // idempotente por naturaleza
      }
      if (transaccion.estado !== 'APROBADO') {
        throw new ErrorHttp(409, 'Solo se reversan transacciones APROBADAS');
      }

      const adaptador = obtenerAdaptador(transaccion.medioDePago);
      const resultado = await adaptador.reversar({ codigoAutorizacion: transaccion.codigoAutorizacion });

      transaccion.estado = 'REVERSADO';
      transaccion.motivoReverso = cuerpo.motivo ?? 'sin detalle';
      transaccion.reversadaEn = new Date().toISOString();
      await repositorioCobros.guardar(transaccion);
      metricas.reversos += 1;

      log.info('transaccion reversada', { correlationId, transaccion: transaccion.id, ...resultado });
      return { transaccionId: transaccion.id, estado: 'REVERSADO', ...resultado };
    },
  },

  {
    metodo: 'GET',
    ruta: '/cobros/:id',
    manejador: async ({ parametros }) => {
      const transaccion = await repositorioCobros.buscarPorId(parametros.id);
      if (!transaccion) throw new ErrorHttp(404, `La transaccion "${parametros.id}" no existe`);
      return transaccion;
    },
  },

  /* ---------------------------------------------------------------- */
  /* Panel de caos: permite demostrar el cortacircuitos en vivo         */
  /* ---------------------------------------------------------------- */
  {
    metodo: 'POST',
    ruta: '/caos',
    manejador: ({ cuerpo }) => {
      if (cuerpo.tasaFallo !== undefined) caos.tasaFallo = Math.min(1, Math.max(0, Number(cuerpo.tasaFallo)));
      if (cuerpo.latenciaExtraMs !== undefined) caos.latenciaExtraMs = Math.max(0, Number(cuerpo.latenciaExtraMs));
      if (cuerpo.caido !== undefined) caos.caido = Boolean(cuerpo.caido);
      log.warn('configuracion de caos modificada', caos);
      return { caos };
    },
  },
  { metodo: 'GET', ruta: '/caos', manejador: () => ({ caos }) },

  {
    metodo: 'GET',
    ruta: '/diagnostico',
    manejador: () => ({
      servicio: 'pagos',
      metricas,
      caos,
      mediosDePago: MEDIOS_DE_PAGO,
      clavesIdempotencia: registroIdempotencia.size,
      transacciones: repositorioCobros.tamano,
    }),
  },
];

crearServidor({
  nombre: 'pagos',
  puerto: config.puertoDe('pagos'),
  rutas,
  // La sonda de readiness refleja el caos: si la pasarela esta caida, el
  // orquestador deja de enviarle trafico (Health Endpoint Monitoring).
  sondaSalud: () => ({ ok: !caos.caido, detalle: { caos, transacciones: repositorioCobros.tamano } }),
});
