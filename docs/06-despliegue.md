# 6. Despliegue en la nube

La actividad exige que el prototipo **sea capaz de ejecutarse en la nube**. Aquí están las tres
formas de hacerlo, de la más simple a la más fiel a producción.

---

## 6.1 Opción A — Local (para desarrollo y para la grabación del video)

```bash
cd prototipo
npm start
```

Seis procesos Node, puertos 8080–8085. Panel en <http://127.0.0.1:8080>.
Es la opción recomendada **para grabar el video**: no depende de internet, no hay servicios que
«despierten» y la demostración es determinista.

---

## 6.2 Opción B — Contenedores (topología idéntica a la de producción)

```bash
cd prototipo
docker compose up --build
```

Seis contenedores en una red privada, con `notificaciones` **replicado dos veces** para mostrar
los consumidores en competencia. Solo el gateway publica un puerto.

Detalle de diseño en el `Dockerfile`: **una sola imagen para los seis servicios**, diferenciados
por la variable `SERVICIO`. Se llama *single artifact, multiple roles* y tiene tres ventajas
concretas: una sola imagen que construir, escanear y firmar; imposibilidad de que dos servicios
corran versiones distintas de `lib/`; y un registro de contenedores con una imagen en lugar de
seis.

El contenedor corre como **usuario sin privilegios** y declara un `HEALTHCHECK` que consulta
`/health`: si un servicio deja de responder, el orquestador lo reinicia solo.

---

## 6.3 Opción C — Nube pública

### C.1 Render.com (recomendado: gratuito y sin tarjeta)

El archivo [`../render.yaml`](../render.yaml) es un *blueprint* que crea los seis servicios.

1. Subir el repositorio a GitHub.
2. En Render: **New → Blueprint** y seleccionar el repositorio.
3. Render lee `render.yaml`, construye la imagen y despliega los seis servicios, inyectando en
   las variables `URL_*` la **URL pública** de cada uno (`https://armonia-<servicio>.onrender.com`).
4. La URL del servicio `armonia-gateway` es la de la aplicación.

**Advertencias del plan gratuito**, importantes si se va a grabar la demostración:

- Los servicios se duermen tras 15 minutos sin tráfico y tardan ~30-50 s en despertar. Antes de
  grabar, conviene visitar la URL de **cada uno** de los seis servicios una vez (o hacer un par
  de peticiones a `/api/salud` seguidas) y esperar a que responda `operativo`.
- Solo hay 750 horas gratuitas al mes en total. Seis servicios las consumen rápido: conviene
  desplegar poco antes de grabar y suspenderlos después.
- **Render documenta explícitamente:** *"Free web services can send private network requests,
  but they can't receive them."* Con seis servicios en plan gratuito, ninguno puede recibir
  tráfico de otro por la red privada. Por eso `render.yaml` hace que cada servicio llame a los
  demás por su **URL pública** en vez de por `fromService`/`hostport`: es la misma vía por la
  que el navegador llega al gateway, y sí acepta tráfico en el plan gratuito. La contrapartida es
  una vuelta extra por Internet en cada llamada entre servicios (más latencia) y que los cinco
  servicios internos quedan también expuestos públicamente, no solo el gateway. En un plan de
  pago (Starter o superior) sí se puede recibir por la red privada, y ahí conviene volver a
  `fromService`/`hostport` para menor latencia y para que los servicios internos dejen de tener
  URL pública; el código de `lib/config.js` ya acepta ambos formatos sin cambios.

**Si solo se dispone de un servicio gratuito**, existe un modo de contingencia: desplegar un
único servicio con `SERVICIO=todos`, que arranca la malla completa dentro de un contenedor.
Se pierde el escalado independiente —y hay que decirlo así en la sustentación— pero la
demostración funciona.

### C.2 Azure Container Apps

Es la opción más alineada con la bibliografía de la unidad (los *Cloud Design Patterns* son de
Microsoft) y con lo que se usaría en la empresa real.

```bash
az group create --name rg-armonia --location eastus
az containerapp env create --name env-armonia --resource-group rg-armonia --location eastus

# El registro y la construcción de la imagen se hacen una sola vez
az acr create --name acrarmonia --resource-group rg-armonia --sku Basic
az acr build --registry acrarmonia --image armonia:v1 ./prototipo

# Un contenedor por servicio; solo el gateway con ingreso externo
az containerapp create --name broker --resource-group rg-armonia \
  --environment env-armonia --image acrarmonia.azurecr.io/armonia:v1 \
  --env-vars SERVICIO=broker --ingress internal --target-port 8085

az containerapp create --name gateway --resource-group rg-armonia \
  --environment env-armonia --image acrarmonia.azurecr.io/armonia:v1 \
  --env-vars SERVICIO=gateway URL_BROKER=http://broker \
  --ingress external --target-port 8080 --min-replicas 2 --max-replicas 10
```

Container Apps aporta de fábrica tres cosas que el prototipo simula: autoescalado por métricas
(incluida la longitud de cola, vía KEDA), DNS interno entre servicios y despliegues azul/verde
con división de tráfico.

### C.3 Equivalencias en otros proveedores

| Concepto | AWS | Azure | Google Cloud |
|---|---|---|---|
| Contenedores gestionados | ECS Fargate | Container Apps | Cloud Run |
| Cola de mensajes | SQS + SNS | Service Bus | Pub/Sub |
| Caché distribuida | ElastiCache | Cache for Redis | Memorystore |
| Base de datos | RDS PostgreSQL | Database for PostgreSQL | Cloud SQL |
| Gateway gestionado | API Gateway | API Management | API Gateway |
| Secretos | Secrets Manager | Key Vault | Secret Manager |

Ninguna decisión del prototipo depende de un proveedor concreto (RNF-16): la portabilidad la
garantizan los contenedores y la configuración externalizada.

---

## 6.4 Qué habría que cambiar para producción

El prototipo **no** es apto para producción tal cual. Estos son los cambios, en orden de
prioridad:

| # | Cambio | Por qué | Esfuerzo |
|---|---|---|---|
| 1 | Sustituir los repositorios en memoria por PostgreSQL | Sin persistencia se pierde todo al reiniciar | Medio: implementar la interfaz `Repositorio` |
| 2 | Sustituir el broker propio por SQS o Service Bus | El propio no persiste ni replica | Bajo: solo cambia `lib/bus.js` |
| 3 | Sustituir `CacheEnMemoria` por Redis | La caché por instancia desperdicia memoria y no invalida entre réplicas | Bajo: misma interfaz |
| 4 | Autenticación OAuth 2.0 / OIDC | Las claves estáticas no caducan ni se revocan | Medio |
| 5 | Secretos en un almacén gestionado | Hoy están en variables de entorno | Bajo |
| 6 | Trazado distribuido con OpenTelemetry | El correlation id da trazas, no tiempos por tramo | Medio |
| 7 | Alertas sobre SLO | Hoy hay métricas pero nadie avisa | Medio |
| 8 | Mínimo dos réplicas del gateway en zonas distintas | Con una instancia es un punto único de fallo | Bajo |
| 9 | Particionar el inventario de eventos masivos | El bloqueo optimista degrada con mucha contención | Alto |
| 10 | Integración y despliegue continuos con canary | Hoy el despliegue es manual | Medio |

---

## 6.5 Costo estimado en operación normal

Estimación para Azure Container Apps con el perfil de carga del caso (RB-1: máximo 8 000
USD/mes):

| Componente | Configuración | USD/mes |
|---|---|---:|
| Container Apps (línea base) | 12 vCPU-h/día promedio | ~1 100 |
| Container Apps (picos de *onsale*) | 8 eventos/mes × 30 min a escala máxima | ~450 |
| PostgreSQL (3 instancias) | 2 vCPU, 8 GB, alta disponibilidad | ~1 400 |
| Redis | 6 GB, estándar | ~280 |
| Service Bus | Estándar, ~50 M operaciones | ~180 |
| Balanceador + WAF | — | ~350 |
| Observabilidad | 40 GB de logs/mes | ~320 |
| CDN | 2 TB de transferencia | ~180 |
| **Total** | | **~4 260** |

Queda **holgadamente por debajo del límite de RB-1**, y el 12 % del costo corresponde a los
picos, que es precisamente lo que RB-2 pedía: pagar por la demanda real. En el monolito actual,
soportar el mismo pico exigiría mantener la capacidad máxima **todo el mes**.

> Estas cifras son estimaciones con precios de lista públicos, sin descuentos por compromiso ni
> créditos. Sirven para comparar arquitecturas, no como cotización.

---

**Anterior:** [5. Plan de pruebas](05-plan-de-pruebas.md) ·
**Volver al** [README](../README.md)
