# ADR-006 — Migración incremental desde el monolito (Strangler Fig)

**Estado:** Propuesta · **Fecha:** 2026-08

## Contexto

RB-3 prohíbe apagar el monolito de un día para otro. La empresa vende todos los días y una
migración de tipo *big bang* pondría en riesgo la operación completa.

## Decisión

Aplicar el patrón **Strangler Fig** (Fowler, 2004): el API Gateway se coloca delante del
monolito y enruta cada funcionalidad al destino correcto. Se migra una capacidad a la vez y,
cuando el monolito deja de recibir tráfico, se apaga.

Orden propuesto, de menor a mayor riesgo:

| Fase | Qué se migra | Por qué en ese orden | Duración |
|---|---|---|---|
| 1 | Gateway delante del monolito | Sin cambio funcional; se gana observabilidad desde el primer día | 3 semanas |
| 2 | Catálogo | Solo lectura: si falla, se vuelve a enrutar al monolito sin pérdida de datos | 6 semanas |
| 3 | Notificaciones | Asíncrono y fuera del camino crítico | 4 semanas |
| 4 | Pagos | Aislarlo primero reduce el alcance de la certificación PCI-DSS | 8 semanas |
| 5 | Reservas e inventario | El más riesgoso; se hace último, con doble escritura y comparación durante 2 semanas | 12 semanas |
| 6 | Apagado del monolito | — | 2 semanas |

## Consecuencias

**A favor:** cada fase entrega valor y es reversible; el equipo aprende sobre el sistema con
menos riesgo en las primeras fases; el negocio nunca se detiene.

**En contra:** durante 8 a 10 meses conviven dos sistemas, con el costo de infraestructura y la
carga cognitiva que eso implica. La fase 5 requiere doble escritura y un mecanismo de
reconciliación: trabajo desechable, pero imprescindible.
