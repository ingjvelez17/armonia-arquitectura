# 3. Selección y justificación de patrones de diseño

## 3.1 Cómo se seleccionaron

Un patrón no se elige porque esté de moda ni porque «los microservicios lo usan». Se eligió
siguiendo tres reglas:

1. **Todo patrón responde a un requisito no funcional concreto.** Si no se puede señalar el
   RNF que lo justifica, se descarta.
2. **Todo patrón tiene un costo.** Se documenta explícitamente qué se paga por él.
3. **Todo patrón se demuestra.** Si no hay una prueba automatizada o un paso de la demostración
   que lo evidencie, no está realmente implementado.

Las fuentes principales son el catálogo de *Cloud Design Patterns* de Microsoft (2024), los
patrones de microservicios de Richardson (2018), los patrones de integración empresarial de
Hohpe y Woolf (2003) y los patrones de diseño clásicos de Gamma et al. (1994).

---

## 3.2 Tabla maestra

| # | Patrón | Categoría | RNF que atiende | Dónde vive |
|---|---|---|---|---|
| 1 | API Gateway (Routing) | Nube / mensajería | RNF-13, RNF-14 | `services/gateway/index.js` |
| 2 | Gateway Aggregation / BFF | Nube / rendimiento | RNF-02 | `GET /api/bff/evento/:id` |
| 3 | Gateway Offloading | Nube / seguridad | RNF-14, RNF-15 | Middleware `offloading()` |
| 4 | Cache-Aside | Nube / rendimiento | RNF-01 | `lib/cache.js` |
| 5 | CQRS + Materialized View | Nube / datos | RNF-01, RNF-03 | `services/catalogo/index.js` |
| 6 | Database per Service | Nube / datos | RNF-11, RNF-16 | Un repositorio por servicio |
| 7 | Saga (orquestada) | Nube / datos | RF-04, RF-07 | `ejecutarSagaDeCompra()` |
| 8 | Compensating Transaction | Nube / datos | RF-07, RF-11 | `liberarCupo()` |
| 9 | Retry con jitter | Nube / resiliencia | RNF-08 | `lib/resiliencia.js` |
| 10 | Circuit Breaker | Nube / resiliencia | RNF-06, RNF-07 | `lib/resiliencia.js` |
| 11 | Bulkhead | Nube / resiliencia | RNF-06 | `lib/resiliencia.js` |
| 12 | Throttling | Nube / seguridad | RNF-14 | `LimitadorDeTasa` |
| 13 | Ambassador | Nube / resiliencia | RNF-06, RNF-13 | `lib/cliente-servicio.js` |
| 14 | Idempotent Receiver | Mensajería | RNF-10 | Reservas y pagos |
| 15 | Publisher-Subscriber | Mensajería | RNF-11 | `services/broker/` |
| 16 | Queue-Based Load Leveling | Nube / escalabilidad | RNF-03 | `services/broker/` |
| 17 | Competing Consumers | Mensajería | RNF-03 | `services/notificaciones/` |
| 18 | Dead Letter Queue | Mensajería | RNF-05 | `services/broker/` |
| 19 | Health Endpoint Monitoring | Nube / operación | RNF-05, RNF-13 | `lib/http.js` |
| 20 | Correlation Identifier | Mensajería | RNF-13 | `lib/logger.js`, `lib/http.js` |
| 21 | External Configuration Store | Nube / operación | RNF-16 | `lib/config.js` |
| 22 | Optimistic Offline Lock | Persistencia | RNF-09 | `lib/repositorio.js` |
| 23 | Repository | Persistencia | RNF-16 | `lib/repositorio.js` |
| 24 | Strategy | GoF / comportamiento | RF-05 | `services/reservas/tarifas.js` |
| 25 | Adapter | GoF / estructural | RNF-12, RT-2 | `services/pagos/pasarelas.js` |
| 26 | Observer | GoF / comportamiento | RF-09 | `services/notificaciones/` |
| 27 | Facade | GoF / estructural | Mantenibilidad | `lib/http.js` |
| 28 | Singleton | GoF / creacional | Coherencia de configuración | `lib/config.js` |
| 29 | Factory Method | GoF / creacional | RNF-12 | `obtenerEstrategia()`, `obtenerAdaptador()` |
| 30 | Scheduler Agent Supervisor | Nube / resiliencia | RF-08 | `barrerReservasExpiradas()` |

---

## 3.3 Los seis patrones decisivos

Los treinta están implementados, pero seis son los que sostienen la arquitectura. Se
justifican en profundidad porque son los que hay que defender en la sustentación.

### 3.3.1 Saga orquestada con transacciones compensatorias

**El problema.** Comprar una boleta requiere dos cambios de estado en **dos servicios
distintos**: apartar el cupo (reservas) y cobrar (pagos). En un monolito eso sería una
transacción ACID. Al separar los servicios se pierde esa garantía, y el teorema CAP obliga a
elegir: o consistencia fuerte con dos fases de confirmación (2PC), o disponibilidad con
consistencia eventual.

**Por qué se descartó 2PC.** El *commit* en dos fases bloquea los recursos de todos los
participantes mientras dura el protocolo. Con 100 000 compradores concurrentes eso es
inviable, y peor: si el coordinador cae en mitad del proceso, los participantes quedan
bloqueados indefinidamente. Richardson (2018) es categórico: 2PC no es una opción realista
para microservicios modernos, y menos con un participante externo como una pasarela de pago
que ni siquiera implementa el protocolo.

**La decisión.** Saga **orquestada** (no coreografiada). El servicio de reservas dirige los
cuatro pasos y sabe qué compensar en cada punto.

**Por qué orquestada y no coreografiada.** En una saga coreografiada cada servicio reacciona a
eventos sin que nadie tenga la visión completa. Es más desacoplada, pero **la lógica de la
compra queda repartida en cinco lugares y nadie puede responder «¿en qué paso va esta
compra?»**. Para un flujo de dinero, donde hay que auditar y explicarle a un cliente qué pasó,
la trazabilidad vale más que el desacople. Por eso cada reserva guarda su lista de `pasos`.

**Lo que cuesta.** Hay ventanas de inconsistencia observable: entre el paso 1 y el paso 4 el
cupo está apartado pero no vendido. La compensación puede fallar y necesita supervisión (por
eso el barredor). Y hay que diseñar una compensación por cada paso, lo que duplica el trabajo
de análisis.

**Evidencia.** Prueba de integración *«Compensación: si el pago falla, el cupo vuelve al
inventario»*; paso 5 de `npm run demo`.

---

### 3.3.2 Circuit Breaker + Retry + Timeout + Bulkhead

**El problema.** Tres proveedores de pago externos que fallan. En el incidente de noviembre de
2025 del caso, la caída del proveedor de correo tumbó la venta durante seis horas: cada
petición esperaba el tiempo límite, los hilos se agotaron y el fallo se propagó hacia arriba.
Es el **fallo en cascada**, el modo de falla característico de los sistemas distribuidos.

**La decisión.** Cuatro patrones combinados **en este orden**, todos dentro del embajador:

```
Mamparo  →  Cortacircuitos  →  Reintento  →  Tiempo límite  →  red
(aísla)     (falla rápido)     (absorbe        (nunca
                                transitorios)   espera infinito)
```

**El razonamiento del orden.** El tiempo límite va más adentro porque debe aplicarse a *cada*
intento, no al conjunto. El reintento envuelve al tiempo límite porque reintentar es
precisamente responder a que uno expiró. El cortacircuitos envuelve al reintento porque su
decisión es *«ni siquiera lo intentes»*. Y el mamparo va más afuera porque limita cuántas de
estas cadenas pueden existir a la vez.

**La sutileza que más importa.** El cortacircuitos **distingue el fallo de infraestructura del
rechazo de negocio**. Un HTTP 409 «no hay cupo» significa que el servicio está perfectamente
sano. Contarlo como fallo abriría el circuito por una decisión de negocio y dejaría caído un
servicio que funciona. En el código eso es el parámetro `cuentaComoFallo`, y hay una prueba
unitaria dedicada.

**La segunda sutileza.** Los cortacircuitos son **por ruta, no por servicio**. Si la pasarela
cae, se corta la ruta de compra pero **no** la de consulta de reservas: el usuario sigue
pudiendo ver sus compras anteriores. Un único cortacircuitos por servicio habría apagado
ambas.

**Lo que cuesta.** Tres parámetros que ajustar (umbral, ventana, reintentos) y que dependen
del tráfico real. Mal calibrados, un umbral bajo abre el circuito ante un pico normal y
provoca la caída que pretendía evitar.

**Evidencia medida.** Con la pasarela caída, la latencia de respuesta pasa de **~700 ms a 1 ms**
en cuanto el circuito abre, y el sistema se recupera **solo** al restablecerse. Con un 40 % de
fallos transitorios, el reintento sostiene **6 de 6** compras (paso 7 de la demostración).

---

### 3.3.3 Idempotent Receiver

**El problema.** Es el incidente de junio de 2025: 3 200 clientes cobrados dos veces. En una
red móvil colombiana durante un *onsale*, la petición llega al servidor pero la respuesta se
pierde. El cliente reintenta —o el usuario pulsa «comprar» otra vez— y se cobra de nuevo. **El
problema no es del cliente: es que el servidor no distingue una petición nueva de una repetida.**

**La decisión.** Clave de idempotencia en dos niveles:

| Nivel | Clave | Protege contra |
|---|---|---|
| Cliente → reservas | `idempotency-key` que genera el cliente | El usuario o la app reintentando |
| Reservas → pagos | `cobro-{idReserva}`, derivada | El embajador reintentando por un tiempo límite |

El segundo nivel es el que a menudo se olvida: **el propio patrón Retry es una fuente de
duplicados**. Sin idempotencia en pagos, los tres reintentos del embajador podrían producir
tres cobros si los fallos fueran de respuesta y no de petición.

**Lo que cuesta.** Hay que guardar el registro de claves ya vistas, con su política de
expiración, y decidir qué hacer si llega la misma clave con un cuerpo distinto (aquí se
devuelve la respuesta original; la alternativa estricta sería un HTTP 422).

**Evidencia.** Prueba *«Idempotencia: reenviar la misma clave no genera una segunda compra»*:
el primer envío responde `201`, el segundo `200` con la **misma** reserva.

---

### 3.3.4 Optimistic Offline Lock

**El problema.** Es el incidente de agosto de 2025: 180 boletas sobrevendidas. Dos compradores
leen «quedan 5», ambos restan 1, ambos guardan 4. Se vendieron 2 boletas y solo desapareció 1
del inventario. Es la **actualización perdida**, y con 20 000 personas peleando por una
localidad ocurre miles de veces por minuto.

**Por qué no bloqueo pesimista.** `SELECT ... FOR UPDATE` funciona, pero serializa a todos los
compradores sobre la misma fila. Con la concurrencia de un *onsale* la cola de bloqueos crece
sin control, aparecen interbloqueos y el tiempo de respuesta se dispara. Se cambiaría el
problema de corrección por uno de disponibilidad.

**La decisión.** Cada línea de inventario lleva un número de `version`. Se escribe con
`guardarConVersion(fila, versionLeida)`: si alguien la modificó entre la lectura y la
escritura, el almacén rechaza la operación y se **reintenta el ciclo completo**. Nadie bloquea
a nadie; el conflicto se detecta en vez de prevenirse.

**Un hallazgo real de este trabajo.** La primera implementación usaba **espera exponencial**
para reintentar los conflictos, por analogía con el patrón Retry. La prueba de carga mostró un
**30 % de rechazos**; al subir los reintentos a 12 manteniendo el crecimiento exponencial, el
error subió al **92 %**, porque las esperas acumuladas superaban el tiempo límite del gateway.
La causa es conceptual: **un conflicto de concurrencia no es una caída**. No hay nada
«descansando» que necesite tiempo para recuperarse; el conflicto se resuelve en microsegundos.
La estrategia correcta es una espera **corta y aleatoria, sin crecimiento**. Con ese cambio, y
reduciendo la latencia simulada del almacén de inventario de 20 ms a 5 ms —el inventario es una
tabla OLTP caliente, no un almacén frío como el catálogo— la tasa de error cayó a **menos del
5 %** y las 24 compras simultáneas de la prueba pasaron todas.

Por eso `lib/resiliencia.js` expone dos estrategias, `ESPERAS.exponencial` y
`ESPERAS.jitterCorto`, con la justificación escrita en el código.

**Lo que cuesta.** Bajo contención extrema (más de ~50 escritores sobre la misma fila) el
enfoque degrada. La solución de producción sería particionar el inventario en bloques
(*«localidad GEN bloque 1..10»*) o serializar por cola. Está documentado como limitación
conocida.

**Evidencia.** Paso 10 de la demostración: **20 compradores simultáneos, 4 boletas disponibles,
4 vendidas, 16 rechazadas con HTTP 409, cero sobreventa.**

---

### 3.3.5 Cache-Aside + CQRS con vista materializada

**El problema.** Por cada compra hay entre 50 y 200 consultas. Si cada una golpea la base de
datos, la base cae antes que la aplicación.

**La decisión.** Dos patrones que trabajan juntos:

- **Cache-Aside** en el catálogo, con TTL de 30 s para los eventos y 5 s para la
  disponibilidad, e invalidación explícita cuando llega un evento de dominio.
- **CQRS**: el catálogo mantiene una **vista materializada** de la disponibilidad que se
  actualiza consumiendo los eventos que publica reservas. **No consulta al servicio de
  reservas.** Si lo hiciera, una caída de reservas dejaría la portada sin disponibilidad y se
  habría reintroducido el acoplamiento que los microservicios pretenden eliminar.

**La decisión difícil: consistencia eventual.** El número que ve el usuario puede estar
desactualizado unos cientos de milisegundos. **Se aceptó conscientemente** porque mostrar
«quedan 43» cuando quedan 41 no daña a nadie; lo que no puede fallar es la venta, y esa la
valida siempre el **almacén autoritativo** de reservas. Es la aplicación directa del teorema
CAP: disponibilidad en la lectura, consistencia en la escritura.

**Un detalle que suele olvidarse: la estampida de caché.** Cuando expira la entrada de un
evento popular, N peticiones simultáneas encuentran la caché vacía y **todas** van a la base
de datos a la vez. La implementación coalesce esas peticiones: la primera va al origen y las
demás esperan su misma promesa. La prueba unitaria lo verifica con 25 peticiones concurrentes
y exige exactamente **1** lectura al origen.

**Evidencia medida.** La segunda consulta al catálogo baja de **150 ms a 2 ms** (99 % menos) y
la tasa de aciertos bajo carga es del **99,9 %**.

---

### 3.3.6 Adapter (y por qué no es lo mismo que Strategy)

**El problema.** Tarjeta, PSE y billeteras digitales exponen APIs incompatibles: una trabaja en
centavos y devuelve `{status:'APPROVED'}`, otra en pesos y devuelve `{codigoRespuesta:0}`, la
tercera con cadenas y `{ok:true}`.

**La decisión.** Un adaptador por proveedor que traduce a una interfaz interna única
(`autorizar` / `reversar`). El servicio de pagos **solo conoce esa interfaz**.

**Por qué importa la distinción con Strategy.** Ambos patrones tienen el mismo diagrama de
clases, y por eso se confunden. La diferencia es la **intención**:

| | Adapter | Strategy |
|---|---|---|
| Qué encapsula | Una interfaz **ajena** que no se puede cambiar | Un algoritmo **propio** |
| Quién elige | El sistema, según el medio de pago del cliente | El negocio, según la campaña |
| Si desaparece | Hay que reescribir la integración | Se usa la política por defecto |

En este prototipo conviven los dos y se puede señalar la diferencia con el dedo: `pasarelas.js`
(Adapter) y `tarifas.js` (Strategy). Los adaptadores además funcionan como **capa
anticorrupción** (Evans, 2003): ningún código de proveedor externo contamina el dominio.

**Evidencia.** Prueba *«Adapter: las tres pasarelas exponen la MISMA interfaz de salida»* y
*«traduce el rechazo propio de cada proveedor al formato interno»*.

---

## 3.4 Patrones evaluados y descartados

Documentar lo que **no** se usó es tan importante como lo que sí: demuestra que hubo decisión.

| Patrón | Por qué se descartó |
|---|---|
| **Two-Phase Commit** | Bloquea recursos y no lo soporta la pasarela externa (ver 3.3.1) |
| **Event Sourcing** | Encaja muy bien con el dominio de boletería, pero la complejidad operativa (versionado de eventos, *snapshots*, reconstrucción) desborda a un equipo de 9 personas. La lista de `pasos` de cada reserva da la auditabilidad necesaria a una fracción del costo |
| **Service Mesh (Istio/Linkerd)** | Resolvería la resiliencia con *sidecars*, pero exige un equipo de plataforma dedicado (choca con RB-5) y ocultaría los patrones que esta actividad debe demostrar |
| **Saga coreografiada** | Más desacoplada, pero sin trazabilidad centralizada del flujo de dinero (ver 3.3.1) |
| **Sharding del inventario** | Necesario por encima de ~50 escritores concurrentes por fila; se documenta como evolución, no como necesidad actual |
| **GraphQL en el gateway** | Resolvería la agregación con más flexibilidad, pero añade complejidad de caché y de límite de tasa que el BFF resuelve con dos endpoints |

---

## 3.5 Los patrones GoF y por qué siguen vigentes

Los patrones de Gamma et al. (1994) tienen treinta años y siguen siendo la base. En este
prototipo cumplen un papel distinto al de los patrones de nube: **los de nube resuelven
problemas entre procesos; los GoF resuelven problemas dentro de un proceso.**

| Patrón GoF | Dónde | Qué problema resuelve aquí |
|---|---|---|
| **Strategy** | `tarifas.js` | Agregar una campaña sin tocar el núcleo transaccional |
| **Adapter** | `pasarelas.js` | Aislar tres APIs externas incompatibles |
| **Observer** | `notificaciones/` | Agregar un canal (WhatsApp) sin tocar los existentes |
| **Facade** | `lib/http.js` | Una interfaz uniforme de servidor para los seis servicios |
| **Singleton** | `lib/config.js` | Una única fuente de verdad para la configuración |
| **Factory Method** | `obtenerEstrategia`, `obtenerAdaptador` | Decidir la implementación concreta en un solo lugar |

---

**Anterior:** [2. Arquitectura y UML](02-arquitectura-uml.md) ·
**Siguiente:** [4. Prototipo](04-prototipo.md)
