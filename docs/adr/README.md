# Registros de decisiones de arquitectura (ADR)

Un ADR documenta **una** decisión importante: el contexto en que se tomó, las opciones que se
consideraron, la que se eligió y lo que se paga por ella. El formato es el de Nygard (2011).

La razón de mantenerlos: dentro de un año nadie recordará por qué el prototipo no usa Express
ni por qué la disponibilidad es eventualmente consistente, y sin ese registro alguien
«arreglará» una decisión deliberada.

| ADR | Decisión | Estado |
|---|---|---|
| [ADR-001](ADR-001-microservicios.md) | Microservicios en lugar de monolito modular | Aceptada |
| [ADR-002](ADR-002-saga-orquestada.md) | Saga orquestada en lugar de 2PC o coreografía | Aceptada |
| [ADR-003](ADR-003-consistencia-eventual.md) | Consistencia eventual en la disponibilidad | Aceptada |
| [ADR-004](ADR-004-sin-dependencias.md) | Prototipo sin dependencias externas | Aceptada |
| [ADR-005](ADR-005-bloqueo-optimista.md) | Bloqueo optimista con espera corta | Aceptada |
| [ADR-006](ADR-006-strangler-fig.md) | Migración incremental con Strangler Fig | Propuesta |
