# 4. Implementación del prototipo y evidencia de ejecución

Código completo en [`../prototipo/`](../prototipo/). Instrucciones de ejecución en su
[README](../prototipo/README.md).

## 4.1 Qué se construyó

Una malla de **seis microservicios** en Node.js, sin dependencias externas (ADR-004), que
implementa **30 patrones** y expone un panel web para operarlo en vivo.

| Métrica | Valor |
|---|---|
| Microservicios | 6 |
| Archivos de código | 20 |
| Líneas de código (sin comentarios) | ~2 900 |
| Dependencias de producción | **0** |
| Pruebas automatizadas | 41 (24 unitarias + 17 de integración) |
| Tiempo de ejecución de la suite | 12,1 s |
| Patrones implementados | 30 |

## 4.2 Correspondencia patrón → archivo

| Patrón | Archivo | Elemento |
|---|---|---|
| Circuit Breaker | `lib/resiliencia.js` | `class Cortacircuitos` |
| Retry | `lib/resiliencia.js` | `conReintentos()`, `ESPERAS` |
| Bulkhead | `lib/resiliencia.js` | `class Mamparo` |
| Throttling | `lib/resiliencia.js` | `class LimitadorDeTasa` |
| Ambassador | `lib/cliente-servicio.js` | `class ClienteServicio` |
| Cache-Aside | `lib/cache.js` | `resolver()` |
| Repository + bloqueo optimista | `lib/repositorio.js` | `guardarConVersion()` |
| Singleton + configuración externa | `lib/config.js` | `class ConfiguracionGlobal` |
| Facade + Health Endpoint | `lib/http.js` | `crearServidor()` |
| Correlation Identifier | `lib/logger.js`, `lib/http.js` | `CABECERA_CORRELACION` |
| Publisher-Subscriber | `lib/bus.js`, `services/broker/` | `Publicador`, `/topicos/:t/publicar` |
| Competing Consumers | `lib/bus.js`, `services/notificaciones/` | `class Consumidor` |
| Dead Letter Queue | `services/broker/index.js` | `/mensajes/:id/rechazar` |
| Saga + compensación | `services/reservas/index.js` | `ejecutarSagaDeCompra()` |
| Idempotent Receiver | `services/reservas/`, `services/pagos/` | `registroIdempotencia` |
| Strategy | `services/reservas/tarifas.js` | `EstrategiaDeTarifa` |
| Adapter | `services/pagos/pasarelas.js` | `AdaptadorDePasarela` |
| Observer | `services/notificaciones/index.js` | `DespachadorDeNotificaciones` |
| CQRS + Materialized View | `services/catalogo/index.js` | `proyeccionDisponibilidad` |
| Gateway Routing/Aggregation/Offloading | `services/gateway/index.js` | rutas y `offloading()` |
| Scheduler Agent Supervisor | `services/reservas/index.js` | `barrerReservasExpiradas()` |

## 4.3 Evidencia de ejecución

Salida real de `npm run demo` (ejecución del 28 de agosto de 2026, sin editar los números).

### Cache-Aside

```
1.1 Primera consulta al catalogo (cache vacia -> va a la base de datos)
  [OK] 4 eventos | origen: base-de-datos | 212 ms
1.2 Segunda consulta identica (deberia resolverse en cache)
  [OK] origen: cache | 2 ms
  |   Reduccion de latencia: 99% (212 ms -> 2 ms)
```

### Saga orquestada — camino feliz

```
  [OK] Reserva RES-6A4323AA | estado CONFIRMADA | 290 ms
  |   Tarifa "estudiante": subtotal $1.560.000 COP - descuento $468.000 COP = $1.092.000 COP
  |   Pasos de la saga:
  |      reservar-cupo      ok
  |      calcular-tarifa    ok
  |      cobrar             ok
  |      confirmar          ok
```

### Idempotencia

```
  [OK] 1er envio -> HTTP 201, reserva RES-C37E67BD
  [OK] 2do envio -> HTTP 200, reserva RES-C37E67BD
  [OK] MISMA reserva devuelta: no se cobro dos veces ni se descontaron 2 boletas.
```

### Compensación

```
  |   Boletas disponibles en Balcon ANTES: 599
  [!] La compra fallo con HTTP 503: la reserva fue liberada y no se realizo ningun cobro
  |      reservar-cupo      ok
  |      calcular-tarifa    ok
  |      compensar          ejecutada
  |   Boletas disponibles en Balcon DESPUES: 599
  [OK] El cupo se devolvio integro: la transaccion compensatoria funciono.
```

### Circuit Breaker — el resultado más contundente

```
  [INTENTO]  #1 HTTP 503 en   711 ms   El servicio "pagos" respondio 503
  [INTENTO]  #2 HTTP 503 en   591 ms   El servicio "pagos" respondio 503
  [INTENTO]  #3 HTTP 503 en   615 ms   El servicio "pagos" respondio 503
  [CORTADO]  #4 HTTP 503 en     1 ms   Cortacircuitos ABIERTO
  [CORTADO]  #5 HTTP 503 en     1 ms   Cortacircuitos ABIERTO
  [CORTADO]  #6 HTTP 503 en     0 ms   Cortacircuitos ABIERTO
  [CORTADO]  #7 HTTP 503 en     1 ms   Cortacircuitos ABIERTO
  [CORTADO]  #8 HTTP 503 en     1 ms   Cortacircuitos ABIERTO

  |   gateway -> reservas (lecturas): CERRADO   <- sigue operativo
  |   gateway -> reservas:compra    : ABIERTO   <- solo se corta la compra
  [OK] El circuito paso a SEMIABIERTO, la peticion de prueba funciono y volvio a CERRADO.
```

**De 711 ms a 1 ms.** Es la diferencia entre degradarse y caerse: sin cortacircuitos, cada
usuario ocupa un hilo durante casi un segundo esperando un servicio que se sabe caído, y con
suficiente tráfico se agotan los hilos y cae toda la plataforma. Nótese además que el circuito
de **lectura** de reservas permanece CERRADO: el usuario sigue pudiendo consultar sus compras.

### Retry, Throttling y concurrencia

```
  [OK] 6/6 compras completadas pese al 40% de fallos en la pasarela
  [OK] 300 atendidas, 60 rechazadas con HTTP 429  (limite: 300 peticiones/minuto)
  [OK] Compras exitosas: 4 | rechazadas por falta de cupo: 16
  [OK] No hubo sobreventa: se vendieron 4 de 4 boletas disponibles.
```

### Pruebas automatizadas

```
ℹ tests 41
ℹ pass 41
ℹ fail 0
ℹ duration_ms 12107.65
```

### Prueba de carga

`npm run carga` con 20 clientes concurrentes, 8 segundos por escenario:

| Escenario | Peticiones | rps | p50 | p95 | p99 | Error |
|---|---:|---:|---:|---:|---:|---:|
| Catálogo (cacheado) | 29 933 | 3 738,8 | 5 ms | 8 ms | 10 ms | 0 % |
| Agregación BFF | 14 375 | 1 794,2 | 11 ms | 14 ms | 16 ms | 0 % |
| Compra completa (saga) | 222 | 26,3 | 408 ms | 800 ms | 1 035 ms | 4,50 % |
| Compra con 30 % de fallos | 211 | 25,0 | 441 ms | 850 ms | 1 123 ms | 3,32 % |

Estado final: **99,9 %** de aciertos de caché, **1 044** conflictos de concurrencia resueltos
sin intervención y **0** localidades con inventario negativo.

> Advertencia honesta sobre estas cifras: son de un prototipo en una sola máquina, con almacenes
> en memoria y sin red real. Sirven para **comparar escenarios entre sí** —y ahí la comparación
> es válida y contundente— pero **no** como estimación de capacidad de producción.

## 4.4 Verificación de los requisitos no funcionales

| RNF | Objetivo | Medido | Estado |
|---|---|---|---|
| RNF-01 | Catálogo p95 < 300 ms | 8 ms | ✅ |
| RNF-02 | Compra p95 < 3 s | 800 ms | ✅ |
| RNF-06 | Fallo rápido < 500 ms con pagos caído | 1 ms | ✅ |
| RNF-07 | Recuperación automática < 30 s | ~5 s | ✅ |
| RNF-08 | ≥ 90 % de compras con 40 % de fallos | 100 % (6/6) | ✅ |
| RNF-09 | Sobreventa = 0 | 0 en todos los escenarios | ✅ |
| RNF-10 | 1 cobro por N reintentos | Verificado | ✅ |
| RNF-13 | Traza reconstruible con un identificador | Verificado | ✅ |
| RNF-14 | Límite de tasa por cliente | 60 de 360 rechazadas | ✅ |
| RNF-03 | 100 000 usuarios en 60 s | **No verificable** en un prototipo local | ⚠️ Pendiente |
| RNF-05 | 99,9 % de disponibilidad | **No verificable** sin operación real | ⚠️ Pendiente |

Los dos pendientes se declaran explícitamente: exigen una prueba de carga distribuida con
generadores externos y una ventana de operación real de al menos un mes. Afirmar que se
cumplen a partir de esta evidencia sería incorrecto.

---

**Anterior:** [3. Patrones de diseño](03-patrones-de-diseno.md) ·
**Siguiente:** [5. Plan de pruebas](05-plan-de-pruebas.md)
