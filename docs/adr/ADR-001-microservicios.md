# ADR-001 — Arquitectura de microservicios en lugar de monolito modular

**Estado:** Aceptada · **Fecha:** 2026-08 · **Decide:** equipo de arquitectura

## Contexto

La plataforma actual es un monolito PHP que no soporta el perfil de carga del negocio: de 200 a
100 000 usuarios concurrentes en 60 segundos, y de vuelta a la línea base en 20 minutos
(RNF-03). Además, cada despliegue arriesga todo el sistema (incidente de enero de 2026) y el
presupuesto de infraestructura está limitado a 8 000 USD/mes (RB-1) con exigencia de pago por
uso (RB-2).

## Opciones consideradas

1. **Monolito modular escalado horizontalmente.** Más simple de operar y de depurar. Se
   descarta porque obliga a replicar *todo* el sistema para absorber un pico que afecta al 20 %
   del código, lo que multiplica el costo por cinco, y porque no permite desplegar el catálogo
   sin detener la venta (RNF-11).
2. **Serverless puro (FaaS).** Encaja con el perfil de picos y con RB-2. Se descarta por el
   arranque en frío en el minuto crítico del *onsale* (amenaza RNF-02) y porque la saga con
   estado obliga a un orquestador propietario que viola RNF-16.
3. **Microservicios con contenedores.** *(elegida)*

## Decisión

Seis microservicios delimitados por capacidad de negocio, en contenedores, con base de datos
por servicio y autoescalado independiente.

## Consecuencias

**A favor:** cada servicio escala con la métrica que le corresponde (notificaciones por
longitud de cola, catálogo por CPU); un fallo se aísla; los despliegues son independientes.

**En contra:** aparece toda la complejidad del cómputo distribuido —consistencia eventual,
fallos parciales, trazado distribuido, más piezas que operar—. Se asume conscientemente y se
mitiga con los patrones de resiliencia y observabilidad de la sección 3.

**Riesgo principal:** convertirse en un *monolito distribuido* si los servicios terminan
llamándose en cadena síncrona. Se mitiga con la regla de que toda comunicación fuera del camino
crítico del usuario debe ser asíncrona.
