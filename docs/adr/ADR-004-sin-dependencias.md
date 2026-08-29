# ADR-004 — Prototipo sin dependencias externas

**Estado:** Aceptada · **Fecha:** 2026-08

## Contexto

El prototipo es un artefacto **académico**: debe ser reproducible por un docente en cualquier
máquina, sobrevivir a la evaluación meses después y hacer visibles los patrones que se están
enseñando.

## Opciones consideradas

1. **Express + RabbitMQ + Redis + PostgreSQL.** Es lo que se usaría en producción. Se descarta
   para el prototipo: exige Docker y descargar imágenes, cualquier cambio de versión puede
   romper la evaluación, y los patrones quedarían ocultos dentro de las bibliotecas —el
   cortacircuitos sería una línea de configuración de Polly u opossum, no algo que se pueda
   mostrar y explicar.
2. **Solo biblioteca estándar de Node.js.** *(elegida)*

## Decisión

Cero dependencias en `package.json`. El servidor HTTP, el broker de mensajes, la caché y el
repositorio se implementan sobre la biblioteca estándar, respetando la **semántica** de los
productos que sustituyen: el broker implementa arrendamientos con *visibility timeout* y cola
de mensajes muertos igual que Amazon SQS.

## Consecuencias

**A favor:** `git clone` y `node` bastan; no hay `npm install` que pueda fallar; superficie de
ataque nula; cada patrón es código legible y comentado; las 41 pruebas corren en 12 segundos.

**En contra:** las implementaciones son didácticas, no de producción: el broker no persiste ni
replica, la caché no es distribuida y los almacenes son mapas en memoria. **La migración a
productos gestionados no cambia la lógica de negocio**, porque toda la infraestructura está
detrás de interfaces (`RepositorioEnMemoria`, `CacheEnMemoria`, `ClienteServicio`): basta
escribir una subclase.
