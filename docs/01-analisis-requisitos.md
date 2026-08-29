# 1. Análisis de requisitos

## 1.1 Técnica de elicitación aplicada

Los requisitos no se listaron por intuición. Se derivaron con tres técnicas complementarias,
en este orden:

1. **Análisis de incidentes.** Cada uno de los cinco incidentes del caso se convirtió en una
   pregunta: *¿qué requisito, de haber existido, lo habría evitado?* Esto produce requisitos
   con una justificación verificable en lugar de deseos genéricos.
2. **Historias de usuario con criterios de aceptación** (Cohn, 2004), para el lado funcional.
3. **Escenarios de atributos de calidad**, en el formato del método ATAM del SEI
   (Bass, Clements y Kazman, 2021): *fuente → estímulo → artefacto → entorno → respuesta →
   medida de la respuesta*. Es lo que convierte «el sistema debe ser rápido» —que no se puede
   probar— en un número que sí se puede medir.

## 1.2 Actores

| Actor | Tipo | Descripción |
|---|---|---|
| **Comprador** | Primario, humano | Consulta eventos y compra boletas desde web o app móvil |
| **Administrador de catálogo** | Primario, humano | Publica eventos, define localidades y precios |
| **Operador de plataforma** | Primario, humano | Vigila la salud del sistema y responde incidentes |
| **Pasarela de pago** | Secundario, sistema | Tarjeta, PSE o billetera digital. Externo y falible |
| **Proveedor de mensajería** | Secundario, sistema | Correo, SMS y notificaciones push |
| **Reloj del sistema** | Secundario, temporal | Dispara la expiración de reservas abandonadas |

## 1.3 Requisitos funcionales

Prioridad según MoSCoW: **M**ust, **S**hould, **C**ould.

| ID | Requisito | Prio. | Criterio de aceptación (verificable) |
|---|---|---|---|
| **RF-01** | Consultar el catálogo de eventos, con filtro por ciudad | M | `GET /api/eventos?ciudad=Bogota` devuelve solo eventos de esa ciudad en < 300 ms |
| **RF-02** | Consultar el detalle de un evento con sus localidades y precios | M | La respuesta incluye código, nombre y precio de cada localidad |
| **RF-03** | Consultar la disponibilidad real de cada localidad | M | El número mostrado no difiere del inventario autoritativo en más de 2 s |
| **RF-04** | Reservar y comprar entre 1 y 6 boletas de una localidad | M | Se rechaza con HTTP 400 una petición de 7 boletas |
| **RF-05** | Aplicar políticas de tarifa diferenciadas (general, estudiante, club, dinámica) | S | Tarifa estudiante = 70 % del subtotal, verificado en prueba automatizada |
| **RF-06** | Cobrar por tarjeta, PSE o billetera digital | M | Los tres medios devuelven la misma estructura de respuesta interna |
| **RF-07** | Liberar el cupo automáticamente si el pago falla | M | El inventario antes y después de un pago fallido es idéntico |
| **RF-08** | Liberar el cupo de las reservas abandonadas | M | Una reserva PENDIENTE pasa a EXPIRADA al superar su TTL y devuelve el cupo |
| **RF-09** | Notificar al comprador por correo, SMS y push | M | Una compra confirmada genera envíos por los tres canales |
| **RF-10** | Consultar el histórico de reservas de un cliente | S | `GET /api/reservas?cliente=X` devuelve solo las de ese cliente |
| **RF-11** | Reembolsar una compra confirmada | S | El estado pasa a REEMBOLSADA, se reversa el cobro y vuelve el cupo |
| **RF-12** | Exponer el estado de salud de cada servicio | M | Cada servicio responde `/health` y `/health/ready` |
| **RF-13** | Trazar cada operación con un identificador de correlación | M | El `x-correlation-id` del cliente aparece en la respuesta y en los logs de los 5 servicios |

### Historias de usuario principales

> **HU-01 — Comprar boletas**
> *Como* comprador, *quiero* comprar boletas para un concierto *para* asegurar mi entrada
> antes de que se agoten.
> **Dado** que hay cupo en la localidad, **cuando** envío la compra con un medio de pago válido,
> **entonces** recibo una confirmación con el número de reserva y el total en menos de 3 segundos.
> **Y dado** que el pago falla, **entonces** no se me cobra nada y las boletas vuelven a estar
> disponibles para otros.

> **HU-02 — Reintentar sin miedo**
> *Como* comprador con mala conexión, *quiero* poder reenviar mi compra *para* no quedarme sin
> boletas por culpa de la red.
> **Dado** que ya envié la compra y no vi la respuesta, **cuando** reenvío la misma petición,
> **entonces** el sistema me devuelve la reserva original y **no** me cobra dos veces.

> **HU-03 — Vigilar la plataforma**
> *Como* operador, *quiero* ver en un solo lugar el estado de todos los servicios y de sus
> dependencias *para* saber en menos de un minuto qué está fallando.

## 1.4 Requisitos no funcionales

Cada uno está escrito como escenario de atributo de calidad medible.

| ID | Atributo | Escenario | Medida objetivo |
|---|---|---|---|
| **RNF-01** | Rendimiento | Un comprador consulta el catálogo en operación normal | p95 < 300 ms |
| **RNF-02** | Rendimiento | Un comprador completa una compra en operación normal | p95 < 3 s |
| **RNF-03** | Escalabilidad | 100 000 usuarios concurrentes llegan en 60 s durante un *onsale* | El sistema atiende o encola; no rechaza más del 5 % |
| **RNF-04** | Escalabilidad | La demanda cae tras el *onsale* | La infraestructura se reduce sola en < 10 min (RB-2) |
| **RNF-05** | Disponibilidad | Operación mensual | ≥ 99,9 % (≤ 43 min de caída al mes) |
| **RNF-06** | Resiliencia | La pasarela de pago deja de responder | La consulta de catálogo sigue funcionando; la compra falla en < 500 ms con mensaje claro |
| **RNF-07** | Resiliencia | Un proveedor externo se recupera tras una caída | El sistema vuelve a usarlo sin intervención humana en < 30 s |
| **RNF-08** | Resiliencia | Fallos transitorios del 40 % en la pasarela | ≥ 90 % de las compras se completan |
| **RNF-09** | **Consistencia** | 20 compradores piden a la vez las últimas 4 boletas | Se venden exactamente 4. **Sobreventa = 0, siempre** |
| **RNF-10** | **Consistencia** | El cliente reenvía la misma compra N veces | Exactamente 1 cobro y 1 reserva |
| **RNF-11** | Mantenibilidad | Se despliega un cambio en el catálogo | El motor de ventas no se detiene ni se redespliega |
| **RNF-12** | Mantenibilidad | Se integra una cuarta pasarela de pago | Solo se agrega una clase adaptadora; ningún servicio existente cambia |
| **RNF-13** | Observabilidad | Ocurre un incidente | La traza completa de una compra se reconstruye con un solo identificador |
| **RNF-14** | Seguridad | Un cliente abusivo lanza miles de peticiones | Se limita su tasa sin afectar a los demás clientes |
| **RNF-15** | Seguridad | Datos de tarjeta | Nunca se almacenan en la plataforma (RT-4) |
| **RNF-16** | Portabilidad | Cambio de proveedor de nube | Ningún servicio depende de una API propietaria |

## 1.5 De los requisitos a la arquitectura

Esta tabla es la bisagra del trabajo: cada decisión arquitectónica **responde a un requisito**,
no a una moda.

| Requisito | Fuerza arquitectónica | Decisión que lo atiende |
|---|---|---|
| RNF-03, RNF-04, RNF-11 | Escalar y desplegar por partes | Microservicios con base de datos por servicio |
| RNF-01 | Lecturas masivas y repetidas | Cache-Aside + CQRS con vista materializada |
| RNF-02, RNF-13 | Muchas llamadas desde el móvil | API Gateway con agregación (BFF) |
| RNF-06, RNF-07, RNF-08 | Dependencias externas falibles | Circuit Breaker + Retry + Timeout + Bulkhead |
| RNF-09 | Contención sobre el inventario | Bloqueo optimista con número de versión |
| RNF-10 | La red duplica peticiones | Idempotent Receiver con clave de idempotencia |
| RF-07, RF-11 | No hay transacción ACID distribuida | Saga orquestada con transacciones compensatorias |
| RNF-03, RF-09 | El pico no puede propagarse | Cola de nivelación + consumidores en competencia |
| RNF-12, RT-2 | Tres APIs externas distintas | Adapter + Strategy |
| RNF-14, RNF-15 | Superficie de ataque | Gateway Offloading: auth y límite de tasa en el borde |
| RNF-05, RNF-13 | Detección temprana | Health Endpoint Monitoring + correlación distribuida |
| RNF-16 | Independencia de proveedor | Contenedores y configuración externalizada |
| RB-3 | Migración incremental | Strangler Fig sobre el monolito |

## 1.6 Cómo se verifica cada requisito

| Requisito | Evidencia automatizada |
|---|---|
| RNF-01, RNF-02 | `npm run carga` → tabla de p50/p95/p99 |
| RNF-06, RNF-07 | `tests/integracion.test.js` → *Circuit Breaker: falla rápido y se recupera solo* |
| RNF-08 | `tests/integracion.test.js` → *Retry: con 40 % de fallos la mayoría completa* |
| RNF-09 | `tests/integracion.test.js` → *15 compradores simultáneos no provocan sobreventa* |
| RNF-10 | `tests/integracion.test.js` → *Idempotencia: la misma clave no genera segunda compra* |
| RF-07 | `tests/integracion.test.js` → *Compensación: si el pago falla, el cupo vuelve* |
| RNF-13 | `tests/integracion.test.js` → *Trazabilidad: el correlation id se propaga* |
| RF-05 | `tests/unidad.test.js` → *Strategy: cada política aplica su regla* |
| RNF-12 | `tests/unidad.test.js` → *Adapter: las tres pasarelas exponen la misma interfaz* |

---

**Anterior:** [0. Caso de estudio](00-caso-de-estudio.md) ·
**Siguiente:** [2. Arquitectura y UML](02-arquitectura-uml.md)
