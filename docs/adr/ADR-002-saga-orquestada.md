# ADR-002 — Saga orquestada para la transacción de compra

**Estado:** Aceptada · **Fecha:** 2026-08

## Contexto

Una compra cambia el estado de dos servicios (reservas y pagos) más un sistema externo. Al
separar los servicios se pierde la transacción ACID que garantizaba que ambos cambios ocurrían
o ninguno. Si el pago falla después de apartar el cupo, esas boletas quedarían bloqueadas para
siempre.

## Opciones consideradas

1. **Commit en dos fases (2PC).** Da consistencia fuerte. Se descarta porque bloquea recursos
   en todos los participantes durante el protocolo —inviable con 100 000 usuarios—, porque una
   caída del coordinador bloquea a los participantes de forma indefinida, y porque **la
   pasarela de pago externa no implementa el protocolo**, lo que lo hace directamente
   imposible.
2. **Saga coreografiada.** Cada servicio reacciona a eventos sin coordinador. Más desacoplada,
   pero la lógica de la compra queda repartida y nadie puede responder «¿en qué paso va esta
   compra?». Para un flujo de dinero auditable, la trazabilidad pesa más que el desacople.
3. **Saga orquestada.** *(elegida)*

## Decisión

El servicio de reservas orquesta cuatro pasos —reservar cupo, calcular tarifa, cobrar,
confirmar— y conoce la compensación de cada uno. Cada reserva almacena la lista de pasos
ejecutados con su marca de tiempo.

## Consecuencias

**A favor:** el estado de cualquier compra es consultable; agregar un paso (facturación
electrónica ante la DIAN) es una entrada más en el orquestador; la compensación es explícita y
verificable con pruebas.

**En contra:** el servicio de reservas acumula responsabilidad y conoce a sus colaboradores.
Hay ventanas de inconsistencia observable entre pasos. La compensación puede fallar, por lo que
se registra con nivel `error` y existe un barredor supervisor que rescata las reservas colgadas.
