# ADR-003 — Consistencia eventual en la disponibilidad mostrada

**Estado:** Aceptada · **Fecha:** 2026-08

## Contexto

La pantalla de un evento muestra cuántas boletas quedan. Ese dato vive en el inventario del
servicio de reservas, pero lo consulta el servicio de catálogo, que recibe entre 50 y 200 veces
más tráfico.

## Opciones consideradas

1. **El catálogo consulta a reservas en cada petición.** Dato siempre exacto. Se descarta
   porque acopla el servicio más consultado al más crítico: una caída o una ralentización de
   reservas dejaría la portada inservible, y se habría construido un monolito distribuido.
2. **Base de datos compartida entre ambos.** Se descarta: rompe *Database per Service* y hace
   imposible desplegar o escalar los dos servicios por separado.
3. **Vista materializada actualizada por eventos (CQRS).** *(elegida)*

## Decisión

El catálogo mantiene su propia proyección de la disponibilidad y la actualiza consumiendo los
eventos de dominio `reserva.creada`, `reserva.confirmada`, `reserva.cancelada`,
`reserva.expirada` y `reserva.reembolsada`. **El número mostrado es eventualmente consistente**,
con un desfase típico inferior a 500 ms.

La decisión de venta **nunca** se toma con ese número: la valida el almacén autoritativo de
reservas dentro de la saga.

## Consecuencias

**A favor:** el catálogo sirve consultas aunque reservas esté caído; escala de forma
independiente; la caché puede ser agresiva.

**En contra:** un usuario puede ver «quedan 3» y recibir «cupo insuficiente» al comprar. Se
mitiga con un TTL corto (5 s) en la disponibilidad y con un mensaje de error explícito. Se
considera aceptable: la alternativa —mostrar un número perfecto pero caerse en el pico— es peor
para el negocio.

**Verificación:** prueba de integración *«CQRS: la vista materializada converge con el almacén
autoritativo»*.
