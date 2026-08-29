# ADR-005 — Bloqueo optimista con espera corta para el inventario

**Estado:** Aceptada · **Fecha:** 2026-08

## Contexto

En agosto de 2025 se sobrevendieron 180 boletas por una actualización perdida clásica: dos
compradores leen el mismo saldo, ambos restan, ambos guardan. RNF-09 exige sobreventa **cero**
bajo cualquier nivel de concurrencia.

## Opciones consideradas

1. **Bloqueo pesimista (`SELECT ... FOR UPDATE`).** Correcto, pero serializa a todos los
   compradores sobre la misma fila; con la concurrencia de un *onsale* la cola de bloqueos
   crece sin control y aparecen interbloqueos. Cambia un problema de corrección por uno de
   disponibilidad.
2. **Actualización atómica condicional (`UPDATE ... WHERE disponibles >= n`).** Es la solución
   óptima en un motor SQL real y se recomienda para producción. En el prototipo se prefirió el
   bloqueo optimista porque **hace visible el número de versión** y por tanto el patrón que se
   está enseñando.
3. **Bloqueo optimista con número de versión.** *(elegida)*

## Decisión

Cada línea de inventario lleva `version`. La escritura exige la versión leída; si no coincide,
se reintenta el ciclo completo de lectura y escritura.

**Corrección posterior, derivada de la prueba de carga.** La primera implementación reintentaba
con **espera exponencial**, por analogía con el patrón Retry. Resultados medidos con 12 clientes
concurrentes sobre la misma localidad:

| Configuración | Tasa de error |
|---|---|
| 5 intentos, espera exponencial | 30 % |
| 12 intentos, espera exponencial | **92 %** — las esperas superaban el tiempo límite del gateway |
| 12 intentos, espera corta aleatoria + almacén de 5 ms | **< 5 %** |

La causa es conceptual: **un conflicto de concurrencia no es una caída**. No hay nada
recuperándose que necesite tiempo; el conflicto se resuelve en microsegundos. El backoff
exponencial es correcto para la red y **contraproducente** para la contención de bloqueos. Por
eso `lib/resiliencia.js` expone dos estrategias distintas y documentadas.

## Consecuencias

**A favor:** sobreventa cero verificada; nadie bloquea a nadie; el mecanismo es explícito en el
modelo de datos.

**En contra:** degrada por encima de unos 50 escritores concurrentes sobre la misma fila. La
evolución sería particionar el inventario en bloques o serializar por cola.

**Verificación:** prueba unitaria *«30 compradores concurrentes no provocan sobreventa»*,
prueba de integración *«15 compradores simultáneos»* y paso 10 de la demostración (20
compradores, 4 boletas, 4 vendidas).
