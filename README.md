# Orquestando códigos: la sinfonía de los sistemas

**Arquitectura de microservicios en la nube para una plataforma de boletería**
Caso de estudio: *Armonía S.A.S.*

Arquitectura de Software · Unidad 1 · Actividad 2 (ABP)
**Juan Esteban Vélez Venegas**

---

## Empieza aquí

| Si quieres… | Abre |
|---|---|
| **Ejecutar el prototipo** | `cd prototipo && npm start` → <http://127.0.0.1:8080> |
| **Ver los patrones en acción** | `cd prototipo && npm run demo` |
| **Verificar que funciona** | `cd prototipo && npm test` → 41 pruebas |

Requisito único para todo lo anterior: **Node.js 20 o superior**. Sin dependencias que instalar.

---

## El problema en una frase

Una empresa de boletería cuyo monolito pasa de **200 a 100 000 usuarios concurrentes en 60
segundos** cuando se abre la venta de un concierto, y que en 18 meses acumuló cinco incidentes
graves —una caída de 47 minutos, un doble cobro a 3 200 clientes, una sobreventa de 180
boletas— con **una sola causa estructural: todo está acoplado a todo**.

## La solución en una frase

Seis microservicios delimitados por capacidad de negocio, comunicados de forma síncrona en el
camino crítico y asíncrona fuera de él, con **30 patrones de diseño** que atacan cada uno de
esos incidentes, verificados con **41 pruebas automatizadas**.

---

## Resultados medidos

| | |
|---|---|
| **711 ms → 1 ms** | Tiempo de respuesta al abrirse el cortacircuitos con la pasarela caída |
| **212 ms → 2 ms** | Segunda consulta al catálogo, resuelta en caché (−99 %) |
| **0 boletas sobrevendidas** | 20 compradores simultáneos, 4 boletas: se vendieron 4 |
| **1 044 conflictos resueltos** | De concurrencia, sin una sola inconsistencia |
| **6/6 compras completadas** | Con un 40 % de fallos en la pasarela de pago |
| **41/41 pruebas** | 24 unitarias + 17 de integración sobre la malla real |

---

## Estructura del repositorio

```
.
├── docs/
│   ├── 00-caso-de-estudio.md        empresa, restricciones y expectativas
│   ├── 01-analisis-requisitos.md    13 RF + 16 RNF con criterios de aceptación
│   ├── 02-arquitectura-uml.md       los 7 diagramas y su justificación
│   ├── 03-patrones-de-diseno.md     los 30 patrones y los descartados
│   ├── 04-prototipo.md              implementación y evidencia de ejecución
│   ├── 05-plan-de-pruebas.md        estrategia, casos de prueba y cobertura
│   ├── 06-despliegue.md             nube, costos y camino a producción
│   ├── adr/                         6 registros de decisiones de arquitectura
│   └── diagramas/                   fuentes .mmd + svg/ + png/ + slides/
│
├── prototipo/                       la malla de 6 microservicios
└── render.yaml                      despliegue en Render.com
```

---

## Los diagramas UML

| # | Diagrama | Fuente | Imagen |
|---|---|---|---|
| 1 | Casos de uso | [`.mmd`](docs/diagramas/01-casos-de-uso.mmd) | [SVG](docs/diagramas/svg/01-casos-de-uso.svg) · [PNG](docs/diagramas/png/01-casos-de-uso.png) |
| 2 | Clases | [`.mmd`](docs/diagramas/02-clases.mmd) | [SVG](docs/diagramas/svg/02-clases.svg) · [PNG](docs/diagramas/png/02-clases.png) |
| 3 | Secuencia — compra | [`.mmd`](docs/diagramas/03-secuencia-compra.mmd) | [SVG](docs/diagramas/svg/03-secuencia-compra.svg) · [PNG](docs/diagramas/png/03-secuencia-compra.png) |
| 4 | Secuencia — compensación | [`.mmd`](docs/diagramas/04-secuencia-compensacion.mmd) | [SVG](docs/diagramas/svg/04-secuencia-compensacion.svg) · [PNG](docs/diagramas/png/04-secuencia-compensacion.png) |
| 5 | Despliegue | [`.mmd`](docs/diagramas/05-despliegue.mmd) | [SVG](docs/diagramas/svg/05-despliegue.svg) · [PNG](docs/diagramas/png/05-despliegue.png) |
| 6 | Componentes | [`.mmd`](docs/diagramas/06-componentes.mmd) | [SVG](docs/diagramas/svg/06-componentes.svg) · [PNG](docs/diagramas/png/06-componentes.png) |
| 7 | Estados de la reserva | [`.mmd`](docs/diagramas/07-estados-reserva.mmd) | [SVG](docs/diagramas/svg/07-estados-reserva.svg) · [PNG](docs/diagramas/png/07-estados-reserva.png) |

Están escritos en Mermaid y versionados junto al código: **el diagrama es código**. Si cambia
la arquitectura, cambia el `.mmd` y se regenera la imagen.

Para regenerarlos:

```bash
npx --yes @mermaid-js/mermaid-cli -i docs/diagramas/01-casos-de-uso.mmd \
  -o docs/diagramas/svg/01-casos-de-uso.svg -b "#0d1117"
```

---

## Licencia y autoría

Trabajo académico. Los datos de la empresa, los incidentes y las cifras de negocio son
**ficticios** y se construyeron para el ejercicio; las mediciones técnicas del prototipo son
reales y reproducibles con los comandos de este repositorio.
