# Prototipo — Armonía S.A.S.

Malla de **seis microservicios** en Node.js que implementa la arquitectura propuesta para la
plataforma de boletería de Armonía S.A.S. Sin dependencias externas: se ejecuta con `node` y nada más.

> Documentación completa: [`../informe/INFORME.md`](../informe/INFORME.md) ·
> Diagramas: [`../docs/diagramas/`](../docs/diagramas/) ·
> Decisiones: [`../docs/adr/`](../docs/adr/)

---

## Puesta en marcha

Requisito único: **Node.js 20 o superior** (`node --version`).

```bash
cd prototipo
npm start
```

Abrir **http://127.0.0.1:8080** — panel de control con compra en vivo, inyección de fallos
y métricas de todos los patrones.

| Comando | Qué hace |
|---|---|
| `npm start` | Levanta los 6 microservicios |
| `npm run demo` | Recorrido guiado por los 10 patrones, con evidencia impresa |
| `npm test` | 41 pruebas (24 unitarias + 17 de integración extremo a extremo) |
| `npm run carga` | Prueba de carga: latencias p50/p95/p99 y tasa de error |

`npm test` y `npm run carga` **levantan su propia malla** en puertos alternos: no hace falta
tener nada corriendo y no interfieren con la demostración.

### Con contenedores

```bash
docker compose up --build      # 6 contenedores, igual que en la nube
```

### En la nube

`../render.yaml` es un *blueprint* de Render.com que crea los seis servicios desde GitHub.
Ver [`../docs/06-despliegue.md`](../docs/06-despliegue.md).

---

## Topología

```
                      ┌───────────────────────┐
   navegador  ───────▶│   API GATEWAY  :8080  │  ruteo · agregación · auth
   app móvil          │   (única entrada)     │  límite de tasa · CORS
                      └───┬───────┬───────┬───┘
                          │       │       │
          ┌───────────────┘       │       └────────────────┐
          ▼                       ▼                        ▼
  ┌───────────────┐      ┌─────────────────┐      ┌────────────────┐
  │ CATÁLOGO :8081│      │ RESERVAS  :8082 │─────▶│  PAGOS  :8083  │
  │ caché · CQRS  │◀─────│ saga · bloqueo  │      │ 3 pasarelas    │
  └───────┬───────┘ HTTP │ optimista       │      │ (adaptadores)  │
          │              └────────┬────────┘      └────────────────┘
          │ suscrito              │ publica
          │                       ▼
          │            ┌────────────────────┐         ┌─────────────────────┐
          └───────────▶│   BROKER  :8085    │────────▶│ NOTIFICACIONES :8084│
                       │ colas · DLQ        │         │ 2 consumidores      │
                       └────────────────────┘         └─────────────────────┘
```

---

## Estructura

```
prototipo/
├── lib/                      componentes de arquitectura compartidos
│   ├── config.js             Singleton + External Configuration Store
│   ├── http.js               micro-framework (Facade sobre node:http)
│   ├── logger.js             log estructurado + correlation id
│   ├── resiliencia.js        Retry · Circuit Breaker · Bulkhead · Throttling
│   ├── cache.js              Cache-Aside con anti-estampida
│   ├── repositorio.js        Repository + bloqueo optimista
│   ├── cliente-servicio.js   Ambassador (envuelve toda llamada saliente)
│   └── bus.js                Publisher/Subscriber + Competing Consumers
├── services/
│   ├── gateway/              puerta de entrada, agregación y BFF
│   ├── catalogo/             consultas, caché y proyección CQRS
│   ├── reservas/             saga de compra, inventario, tarifas (Strategy)
│   ├── pagos/                adaptadores de pasarela + inyección de caos
│   ├── notificaciones/       consumidores en competencia + Observer
│   └── broker/               colas, tópicos, arrendamientos y DLQ
├── web/index.html            panel de control de la demostración
├── tests/                    41 pruebas automatizadas
└── scripts/                  arranque, demo guiada y prueba de carga
```

---

## API pública (a través del gateway)

Autenticación: cabecera `x-api-key: demo-armonia-2026` en las operaciones de escritura.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/eventos` | Catálogo (caché). Filtro opcional `?ciudad=Bogota` |
| `GET` | `/api/eventos/:id` | Detalle de un evento |
| `GET` | `/api/bff/evento/:id` | **Agregación**: detalle + precios + disponibilidad real |
| `POST` | `/api/reservas` | Compra (saga). Acepta `idempotency-key` |
| `GET` | `/api/reservas/:id` | Consulta de una reserva |
| `GET` | `/api/reservas?cliente=` | Reservas de un cliente |
| `POST` | `/api/reservas/:id/reembolso` | Transacción compensatoria posterior |
| `GET` | `/api/notificaciones` | Bandeja de mensajes despachados |
| `GET` | `/api/salud` | Salud agregada de los 5 servicios internos |
| `GET` | `/api/panel` | Diagnóstico completo (circuitos, caché, colas, métricas) |
| `POST` | `/api/caos` | Inyecta fallos en la pasarela: `{tasaFallo, latenciaExtraMs, caido}` |

Además, **cada** servicio expone `/health`, `/health/ready` y `/metrics`.

### Ejemplo de compra

```bash
curl -X POST http://127.0.0.1:8080/api/reservas \
  -H "content-type: application/json" \
  -H "x-api-key: demo-armonia-2026" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"eventoId":"EVT-002","localidad":"VIP","cantidad":2,
       "cliente":"juan.velez","tipoTarifa":"estudiante","medioDePago":"tarjeta"}'
```

Repetir la misma petición **con la misma `idempotency-key`** devuelve `200` y la reserva
original: no se cobra dos veces.

---

## Configuración

Todo por variables de entorno (*External Configuration Store*). Las más útiles:

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | — | Puerto inyectado por el PaaS; tiene prioridad |
| `URL_CATALOGO`, `URL_RESERVAS`, … | `127.0.0.1:80xx` | DNS interno de cada servicio |
| `LIMITE_RPM` | `300` | Peticiones por minuto y por clave de API |
| `UMBRAL_FALLOS_CIRCUITO` | `4` | Fallos consecutivos que abren el cortacircuitos |
| `TIEMPO_APERTURA_MS` | `5000` | Cuánto permanece abierto antes de reintentar |
| `REINTENTOS_MAXIMOS` | `3` | Reintentos por llamada saliente |
| `TIMEOUT_MS` | `2500` | Tiempo máximo de espera entre servicios |
| `TTL_CACHE_S` | `30` | Vigencia de la caché del catálogo |
| `TASA_FALLO_PAGOS` | `0.25` | Fallos simulados en la pasarela (0 a 1) |
| `LOG_FORMAT` | texto | `json` para producción |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

---

## Cómo ver cada patrón en 30 segundos

| Patrón | Qué hacer |
|---|---|
| Cache-Aside | Pulsar «Recargar» dos veces: `base-de-datos` → `cache` |
| Agregación / BFF | Seleccionar un evento: una llamada, tres servicios |
| Saga + compensación | Subir «tasa de fallo» al 100% y comprar: el cupo vuelve |
| Idempotencia | «Reenviar misma clave»: devuelve la misma reserva |
| Circuit Breaker | «Tumbar pagos» + «Ráfaga de 10 compras»: de 700 ms a 1 ms |
| Retry | Tasa de fallo al 40% y comprar varias veces: casi todas pasan |
| Pub/Sub + consumidores | Panel 6: notificaciones repartidas entre 2 trabajadores |
| CQRS | Panel 5: «eventos aplicados a la vista» sube tras cada compra |
| Throttling | `npm run demo` (paso 9): 429 al superar el límite |
| Bloqueo optimista | `npm run demo` (paso 10): 20 compradores, 4 boletas, 0 sobreventa |

---

## Limitaciones conocidas

Son deliberadas y están justificadas en la sección 8 del informe:

1. **Persistencia en memoria.** Al reiniciar se pierde el estado. En producción: PostgreSQL
   por servicio y Redis para la caché.
2. **Broker propio.** Cumple la semántica de SQS/Service Bus pero no persiste ni replica.
3. **Autenticación por clave estática.** En producción: OAuth 2.0 / OIDC con tokens de vida corta.
4. **Contención de escritura.** Por encima de ~50 compradores simultáneos sobre la *misma*
   localidad, el bloqueo optimista degrada; la solución es particionar el inventario en
   bloques o serializar por cola.
5. **El gateway es un punto único de fallo** si se despliega con una sola instancia.

---

Juan Esteban Vélez Venegas — Arquitectura de Software, Unidad 1.
