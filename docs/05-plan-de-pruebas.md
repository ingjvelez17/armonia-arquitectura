# 5. Plan de pruebas

> Este capítulo no lo exige explícitamente la rúbrica, pero sí lo exige la arquitectura: en un
> sistema distribuido, **una decisión de diseño que no se puede verificar es una hipótesis**.
> Cada patrón de la sección 3 tiene aquí su prueba correspondiente.

## 5.1 Estrategia: la pirámide, adaptada a lo distribuido

```
                    ┌───────────────────────┐
                    │  Manuales / demo      │  1 recorrido guiado
                    │  npm run demo         │  (sustentación en video)
                    ├───────────────────────┤
                    │  Carga y resiliencia  │  4 escenarios
                    │  npm run carga        │  (p50/p95/p99, caos)
                    ├───────────────────────┤
                    │  Integración E2E      │  17 pruebas
                    │  malla completa real  │  (propiedades del sistema)
                    ├───────────────────────┤
                    │  Unitarias            │  24 pruebas
                    │  sin red, sin espera  │  (contratos de cada patrón)
                    └───────────────────────┘
```

La forma es la pirámide clásica (Cohn, 2009), pero con un matiz propio de los sistemas
distribuidos: **la capa de integración es más gruesa de lo habitual**. La razón es que las
propiedades que más importan aquí —que la saga compense, que no haya sobreventa, que la
proyección converja— son **emergentes**: no existen dentro de ningún componente aislado, solo
aparecen cuando los seis procesos interactúan de verdad. Una prueba unitaria con dobles no
puede detectar una sobreventa causada por dos procesos reales compitiendo.

Por eso `tests/integracion.test.js` **levanta los seis servicios como procesos reales** en
puertos alternos (91xx), ejercita el sistema por HTTP igual que un cliente y los apaga al
terminar. Sin *mocks*, sin dobles: el sistema de verdad.

## 5.2 Tipos de prueba y qué cubre cada uno

| Tipo | Cantidad | Qué verifica | Dónde |
|---|---:|---|---|
| Unitarias de resiliencia | 8 | Contrato de Retry, Circuit Breaker, Bulkhead, Throttling y Timeout | `tests/unidad.test.js` |
| Unitarias de datos | 6 | Cache-Aside (incluida la estampida), bloqueo optimista, actualización perdida | idem |
| Unitarias de patrones GoF | 6 | Strategy y Adapter: mismo contrato, comportamiento distinto | idem |
| Unitarias de concurrencia | 2 | 30 compradores, 5 boletas, sobreventa 0 | idem |
| Integración de contrato | 5 | Códigos HTTP, autenticación, validación, agregación | `tests/integracion.test.js` |
| Integración de flujo | 5 | Saga completa, idempotencia, reembolso, tarifas | idem |
| Integración de resiliencia | 4 | Compensación, cortacircuitos, reintento, degradación | idem |
| Integración de consistencia | 3 | Sobreventa, convergencia CQRS, trazabilidad | idem |
| Carga | 4 escenarios | Latencia, rendimiento, tasa de error con y sin caos | `scripts/prueba-carga.js` |
| **Total automatizado** | **41 + 4** | | |

## 5.3 Casos de prueba destacados

### CP-01 · Sobreventa bajo concurrencia (crítico)

- **Requisito:** RNF-09 · **Tipo:** integración · **Riesgo si falla:** vender boletas inexistentes
- **Precondición:** localidad `EVT-003:PAL` con exactamente 4 boletas disponibles
- **Acción:** 15 peticiones de compra **simultáneas** de 1 boleta cada una
- **Resultado esperado:** exactamente 4 respuestas `201`, 11 respuestas `409`, inventario final = 0
- **Resultado obtenido:** ✅ 4 / 11 / 0. En la demostración con 20 compradores: 4 / 16 / 0
- **Oráculo adicional:** el inventario **nunca** puede quedar negativo. Se verifica al final de
  cada corrida de carga

### CP-02 · Doble cobro por reintento (crítico)

- **Requisito:** RNF-10 · **Tipo:** integración · **Riesgo si falla:** cobrar dos veces al cliente
- **Acción:** dos POST idénticos con la **misma** `idempotency-key`
- **Resultado esperado:** `201` + `200`, mismo `id` de reserva, un solo cobro
- **Resultado obtenido:** ✅

### CP-03 · Compensación de la saga

- **Requisito:** RF-07 · **Tipo:** integración
- **Precondición:** caos activado con 100 % de fallo en la pasarela
- **Acción:** comprar 4 boletas; medir el inventario antes y después
- **Resultado esperado:** la compra falla, el inventario queda **idéntico**, la reserva registra
  el paso `compensar`
- **Resultado obtenido:** ✅

### CP-04 · Fallo rápido y recuperación automática

- **Requisito:** RNF-06, RNF-07 · **Tipo:** integración
- **Acción:** tumbar la pasarela, lanzar 8 compras, medir la latencia de la última; restablecer
  y verificar que el sistema vuelve solo
- **Resultado esperado:** última latencia < 120 ms; recuperación sin reiniciar nada
- **Resultado obtenido:** ✅ 1 ms; recuperación en ~5 s

### CP-05 · Estampida de caché

- **Requisito:** RNF-01 · **Tipo:** unitaria
- **Acción:** 25 peticiones concurrentes sobre una clave ausente
- **Resultado esperado:** **exactamente 1** lectura al origen
- **Resultado obtenido:** ✅

### CP-06 · Degradación de la observabilidad

- **Requisito:** RNF-13 · **Tipo:** integración
- **Acción:** tumbar la pasarela y consultar el panel de diagnóstico
- **Resultado esperado:** el panel responde `200` con la información de los servicios sanos
- **Justificación:** el panel debe funcionar **justo cuando** el sistema está roto, que es
  cuando se necesita. Por eso las llamadas de observabilidad esquivan el cortacircuitos a
  propósito
- **Resultado obtenido:** ✅

## 5.4 Pruebas de caos

El servicio de pagos expone `POST /api/caos` con tres interruptores —`tasaFallo`,
`latenciaExtraMs` y `caido`— que se manipulan **en caliente**, sin reiniciar nada.

Es ingeniería del caos aplicada a escala de prototipo (Basiri et al., 2016): en lugar de
esperar a que el proveedor falle en producción, se provoca el fallo bajo control y se verifica
que el sistema responde como se diseñó.

| Experimento | Hipótesis | Resultado |
|---|---|---|
| Fallo del 100 % | La compra falla limpiamente y el cupo vuelve | ✅ |
| Fallo del 40 % | El reintento absorbe casi todo | ✅ 6/6 |
| Pasarela caída | El circuito abre; las lecturas siguen | ✅ 711 ms → 1 ms |
| Latencia de 3 s | Salta el tiempo límite (2,5 s) antes que el usuario | ✅ |
| Recuperación | Vuelve solo, sin intervención | ✅ ~5 s |

## 5.5 Qué NO se probó, y por qué

Declararlo es parte del trabajo. Omitirlo sería presentar una cobertura falsa.

| Sin cubrir | Por qué | Cómo se cubriría |
|---|---|---|
| Carga real de 100 000 usuarios | Un prototipo local no puede generarla | k6 o Gatling distribuido contra el despliegue en nube |
| Disponibilidad del 99,9 % | Requiere un mes de operación real | Monitoreo sintético + SLO en producción |
| Seguridad (OWASP Top 10) | Fuera del alcance de la actividad | Análisis estático (SAST), dependencias (SCA) y pentest |
| Recuperación ante desastres | No hay persistencia real | Prueba de restauración de respaldos por región |
| Pruebas de contrato entre servicios | El prototipo es un solo repositorio | Pact o esquemas OpenAPI verificados en CI |
| Accesibilidad del panel web | El panel es una herramienta de demostración | Auditoría WCAG 2.2 si pasara a producto |

## 5.6 Cómo reproducir todo

```bash
cd prototipo
npm test              # 41 pruebas; levanta su propia malla
npm run carga         # prueba de carga; levanta su propia malla
npm start             # en una terminal
npm run demo          # en otra: recorrido guiado con evidencia impresa
```

Ninguna prueba requiere configuración previa, servicios externos ni Docker.

---

**Anterior:** [4. Prototipo](04-prototipo.md) ·
**Siguiente:** [6. Despliegue](06-despliegue.md)
